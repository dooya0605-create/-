"use strict";

const express = require("express");
const path = require("node:path");
const app = express();
const PORT = Number(process.env.PORT || 3000);
const CITY_HALL = { lat: 35.0036, lon: 128.0642 };
const TMAP = "https://apis.openapi.sk.com";
const OVERPASS = "https://overpass-api.de/api/interpreter";
const ELEVATION = "https://api.open-meteo.com/v1/elevation";

// Wheelchair speed assumptions are estimates; keep them configurable.
const SLOPE = {
  thresholds: [5.6, 8.3, 12],
  uphillFactors: [{ above: 12, factor: 0.35 }, { above: 8.3, factor: 0.5 }, { above: 5.6, factor: 0.7 }],
  baseWheelchairSpeedMps: 1.0
};
const reports = []; // Replace with SQLite/PostGIS before production.
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

function distance(a, b) {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLon = (b.lon - a.lon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 12742000 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
async function jsonFetch(url, options = {}, ms = 8000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 180)}`);
  try { return JSON.parse(text); } catch { throw new Error(`JSON 응답이 아닙니다: ${text.slice(0, 120)}`); }
}
function parseTmap(data, label) {
  const features = data?.features || [];
  const coords = features.flatMap((f) => {
    if (f.geometry?.type === "LineString") return f.geometry.coordinates;
    if (f.geometry?.type === "MultiLineString") return f.geometry.coordinates.flat();
    return [];
  });
  const path = coords.map(([lon, lat]) => [Number(lat), Number(lon)]).filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
  if (path.length < 2) throw new Error("경로 좌표가 응답에 없습니다.");
  const p = features.find((f) => f.properties)?.properties || {};
  return { label, distance: Number(p.totalDistance || 0), time: Number(p.totalTime || 0), path };
}
async function tmapRoute(start, end, pedestrian, option) {
  if (!process.env.TMAP_APP_KEY) throw new Error("TMAP_APP_KEY 미설정");
  const endpoint = pedestrian ? "/tmap/routes/pedestrian?version=1" : "/tmap/routes?version=1";
  const data = await jsonFetch(`${TMAP}${endpoint}`, {
    method: "POST",
    headers: { appKey: process.env.TMAP_APP_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      startX: String(start.lon), startY: String(start.lat), endX: String(end.lon), endY: String(end.lat),
      startName: start.name || "출발지", endName: end.name || "도착지", searchOption: String(option),
      reqCoordType: "WGS84GEO", resCoordType: "WGS84GEO"
    })
  });
  return parseTmap(data, pedestrian ? (option === "30" ? "휠체어 추천" : "최단 경로 대안") : "자동차 최적 경로");
}
async function naverDrive(start, end) {
  if (!process.env.NAVER_API_KEY_ID || !process.env.NAVER_API_KEY) throw new Error("네이버 Directions 키 미설정");
  const url = new URL(process.env.NAVER_DIRECTIONS_URL || "https://maps.apigw.ntruss.com/map-direction/v1/driving");
  url.searchParams.set("start", `${start.lon},${start.lat}`);
  url.searchParams.set("goal", `${end.lon},${end.lat}`);
  url.searchParams.set("option", "traoptimal");
  const data = await jsonFetch(url, { headers: { "X-NCP-APIGW-API-KEY-ID": process.env.NAVER_API_KEY_ID, "X-NCP-APIGW-API-KEY": process.env.NAVER_API_KEY } });
  const r = data?.route?.traoptimal?.[0] || data?.route?.trafast?.[0];
  const path = (r?.path || []).map(([lon, lat]) => [Number(lat), Number(lon)]).filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
  if (path.length < 2) throw new Error("네이버 경로 좌표 없음");
  return { label: "자동차 최적 경로", distance: Number(r.summary?.distance || 0), time: Number(r.summary?.duration || 0) / 1000, path };
}
function parsePoi(p) {
  const lon = Number(p.frontLon ?? p.noorLon);
  const lat = Number(p.frontLat ?? p.noorLat);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, name: p.name || p.poiName || "장소", address: [p.upperAddrName, p.middleAddrName, p.lowerAddrName, p.detailAddrName].filter(Boolean).join(" ") };
}

// Limited emergency fallback: walking OSM graph and Dijkstra, only for nearby routes.
async function graphFallback(start, end, withSteps = false) {
  if (distance(start, end) > 8000) throw new Error("그래프 대체 경로는 직선거리 8km 이내만 지원합니다.");
  const pad = 0.025, s = Math.min(start.lat, end.lat) - pad, n = Math.max(start.lat, end.lat) + pad;
  const w = Math.min(start.lon, end.lon) - pad, e = Math.max(start.lon, end.lon) + pad;
  const highways = withSteps ? "footway|pedestrian|path|residential|living_street|service|steps" : "footway|pedestrian|path|residential|living_street|service";
  const q = `[out:json][timeout:7];way["highway"~"${highways}"]["foot"!="no"]["access"!="private"](${s},${w},${n},${e});out body;>;out skel qt;`;
  const data = await jsonFetch(OVERPASS, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `data=${encodeURIComponent(q)}` });
  const nodes = new Map(), ways = [], graph = new Map();
  for (const x of data.elements || []) { if (x.type === "node") nodes.set(x.id, { lat: x.lat, lon: x.lon }); else if (x.type === "way") ways.push(x); }
  const edge = (a, b, d) => { if (!graph.has(a)) graph.set(a, []); graph.get(a).push([b, d]); };
  for (const way of ways) for (let i = 1; i < (way.nodes || []).length; i++) {
    const a = way.nodes[i - 1], b = way.nodes[i], pa = nodes.get(a), pb = nodes.get(b);
    if (pa && pb) { const d = distance(pa, pb); edge(a, b, d); edge(b, a, d); }
  }
  const nearest = (p) => { let id, best = Infinity; for (const [k, v] of nodes) { const d = distance(p, v); if (d < best) { id = k; best = d; } } if (best > 1000) throw new Error("가까운 보행 도로를 찾지 못했습니다."); return id; };
  const src = nearest(start), dst = nearest(end), dist = new Map([[src, 0]]), prev = new Map(), queue = new Set([src]);
  while (queue.size) {
    let u, best = Infinity; for (const v of queue) if ((dist.get(v) ?? Infinity) < best) { u = v; best = dist.get(v); }
    queue.delete(u); if (u === dst) break;
    for (const [v, d] of graph.get(u) || []) if (best + d < (dist.get(v) ?? Infinity)) { dist.set(v, best + d); prev.set(v, u); queue.add(v); }
  }
  if (!dist.has(dst)) throw new Error("OSM 보행 그래프에 연결 경로가 없습니다.");
  const ids = []; for (let c = dst; c !== undefined; c = prev.get(c)) { ids.push(c); if (c === src) break; }
  ids.reverse(); const path = ids.map((id) => [nodes.get(id).lat, nodes.get(id).lon]);
  if (dist.get(dst) > 8000) throw new Error("그래프 대체 경로가 8km를 초과합니다.");
  return { label: withSteps ? "보행 그래프 대체 경로(계단 포함 가능)" : "보행 그래프 대체 경로", distance: dist.get(dst), time: dist.get(dst) / 1.2, path, includesSteps: withSteps };
}
function sample(path, spacing = 50) {
  const out = []; let total = 0;
  for (let i = 1; i < path.length; i++) {
    const a = { lat: path[i - 1][0], lon: path[i - 1][1] }, b = { lat: path[i][0], lon: path[i][1] }, len = distance(a, b);
    if (!len) continue;
    const count = Math.max(1, Math.ceil(len / spacing));
    for (let j = 0; j < count; j++) { if (i > 1 && j === 0) continue; const t = j / count; out.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, d: total + len * t }); }
    total += len;
  }
  const last = path[path.length - 1]; if (last) out.push({ lat: last[0], lon: last[1], d: total });
  return out;
}
async function elevation(route) {
  const points = sample(route.path), heights = [];
  if (points.length < 2) throw new Error("경사 분석 좌표 부족");
  for (let i = 0; i < points.length; i += 100) {
    const chunk = points.slice(i, i + 100), url = new URL(ELEVATION);
    url.searchParams.set("latitude", chunk.map((p) => p.lat).join(","));
    url.searchParams.set("longitude", chunk.map((p) => p.lon).join(","));
    const data = await jsonFetch(url);
    if (!Array.isArray(data.elevation) || data.elevation.length !== chunk.length) throw new Error("고도 API 결과 형식이 올바르지 않습니다.");
    heights.push(...data.elevation);
  }
  const segments = []; let wheelchairTime = 0;
  for (let i = 1; i < points.length; i++) {
    const d = points[i].d - points[i - 1].d; if (d <= 0) continue;
    const rise = heights[i] - heights[i - 1], grade = Math.abs(rise / d) * 100;
    const factor = rise > 0 ? (SLOPE.uphillFactors.find((x) => grade > x.above)?.factor || 1) : 1;
    wheelchairTime += d / (SLOPE.baseWheelchairSpeedMps * factor);
    segments.push({ from: [points[i - 1].lat, points[i - 1].lon], to: [points[i].lat, points[i].lon], grade: Number(grade.toFixed(1)), direction: rise > 0 ? "오르막" : rise < 0 ? "내리막" : "평지", distance: Math.round(d) });
  }
  return { segments, wheelchairTime: Math.round(wheelchairTime), elevationAvailable: true };
}
async function obstacles(routes) {
  const points = routes.flatMap((r) => r.path);
  const b = { s: Math.min(...points.map((p) => p[0])) - .003, n: Math.max(...points.map((p) => p[0])) + .003, w: Math.min(...points.map((p) => p[1])) - .003, e: Math.max(...points.map((p) => p[1])) + .003 };
  const q = `[out:json][timeout:7];(node["barrier"="kerb"]["kerb"="raised"](${b.s},${b.w},${b.n},${b.e});node["kerb"="raised"](${b.s},${b.w},${b.n},${b.e});way["highway"="steps"](${b.s},${b.w},${b.n},${b.e});way["wheelchair"="no"](${b.s},${b.w},${b.n},${b.e});node["wheelchair"="no"](${b.s},${b.w},${b.n},${b.e}););out center;`;
  const data = await jsonFetch(OVERPASS, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `data=${encodeURIComponent(q)}` });
  return (data.elements || []).map((x) => {
    const lat = x.lat ?? x.center?.lat, lon = x.lon ?? x.center?.lon; if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon, type: x.tags?.highway === "steps" ? "계단" : x.tags?.kerb === "raised" ? "높은 턱" : "휠체어 통행 불가" };
  }).filter(Boolean);
}

app.get("/api/config", (_req, res) => res.json({ ncpKeyId: process.env.NAVER_MAPS_KEY_ID || "" }));
app.get("/api/pois", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "검색어를 입력해 주세요." });
  if (!process.env.TMAP_APP_KEY) return res.status(503).json({ error: "장소 검색을 사용할 수 없습니다. TMAP_APP_KEY를 설정해 주세요." });
  try {
    const url = new URL(`${TMAP}/tmap/pois`); url.searchParams.set("version", "1"); url.searchParams.set("searchKeyword", q); url.searchParams.set("resCoordType", "WGS84GEO"); url.searchParams.set("count", "20");
    const data = await jsonFetch(url, { headers: { appKey: process.env.TMAP_APP_KEY } });
    const results = (data.searchPoiInfo?.pois?.poi || []).map(parsePoi).filter(Boolean).sort((a, b) => distance(a, CITY_HALL) - distance(b, CITY_HALL));
    res.json({ results });
  } catch (e) { res.status(502).json({ error: `장소 검색 실패: ${e.message}` }); }
});
app.post("/api/routes", async (req, res) => {
  const { start, end, mode = "walk", maxSlope = 12 } = req.body || {};
  if (!start || !end || ![start.lat, start.lon, end.lat, end.lon].every((x) => Number.isFinite(Number(x)))) return res.status(400).json({ error: "출발지와 도착지 좌표를 확인해 주세요." });
  const a = { ...start, lat: Number(start.lat), lon: Number(start.lon) }, b = { ...end, lat: Number(end.lat), lon: Number(end.lon) };
  const failures = []; let routes = [];
  if (mode === "car") {
    try { routes = [await naverDrive(a, b)]; } catch (e) { failures.push(`네이버 자동차 경로: ${e.message}`); try { routes = [await tmapRoute(a, b, false, "0")]; } catch (x) { failures.push(`티맵 자동차 경로: ${x.message}`); } }
  } else {
    const found = await Promise.allSettled([tmapRoute(a, b, true, "30"), tmapRoute(a, b, true, "10")]);
    found.forEach((r, i) => r.status === "fulfilled" ? routes.push(r.value) : failures.push(`티맵 보행 경로(${i ? "최단" : "계단 제외"}): ${r.reason.message}`));
    if (!routes.length) { try { routes = [await graphFallback(a, b)]; } catch (e) { failures.push(`OSM 보행 그래프: ${e.message}`); try { routes = [await graphFallback(a, b, true)]; failures.push("대체 경로에 계단이 포함될 수 있습니다."); } catch (x) { failures.push(`계단 포함 대체 경로: ${x.message}`); } } }
  }
  if (!routes.length) return res.status(502).json({ error: "경로를 찾지 못했습니다. 직선 경로는 표시하지 않습니다.", failures });
  if (mode !== "car") await Promise.all(routes.map(async (r) => { try { r.slope = await elevation(r); } catch (e) { r.slope = { segments: [], elevationAvailable: false }; failures.push(`경사 조회: ${e.message}`); } }));
  let obstacleList = [], obstacleWarning = "";
  try { obstacleList = await obstacles(routes); } catch (e) { obstacleWarning = `장애물 조회 실패: ${e.message}`; failures.push(obstacleWarning); }
  const allowed = [5.6, 8.3, 12].includes(Number(maxSlope)) ? Number(maxSlope) : 12;
  routes = routes.map((r) => ({ ...r, overLimitSegments: (r.slope?.segments || []).filter((x) => x.grade > allowed).length, walkingTime: r.time, wheelchairTime: r.slope?.wheelchairTime ?? null, obstacleWarnings: obstacleList.filter((o) => r.path.some((p) => distance({ lat: p[0], lon: p[1] }, o) < 25)) }));
  if (mode !== "car") routes.sort((x, y) => x.overLimitSegments - y.overLimitSegments || (x.wheelchairTime ?? x.time) - (y.wheelchairTime ?? y.time));
  if (routes.length > 1 && Math.abs(routes[0].distance - routes[1].distance) < 10 && routes[0].path.length === routes[1].path.length) routes = [routes[0]];
  res.json({ routes, obstacles: obstacleList, allowedSlope: allowed, slopeAvailable: routes.some((r) => r.slope?.elevationAvailable), obstacleWarning, failures, notices: ["고도 자료 해상도는 약 90m로 경사 값은 추정치입니다.", "티맵 계단 제외 경로도 턱과 좁은 길을 걸러내지는 않습니다."] });
});
app.get("/api/buses", async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: "정류장 검색 좌표가 올바르지 않습니다." });
  if (!process.env.TAGO_SERVICE_KEY) return res.json({ available: false, message: "버스 정보는 TAGO 서비스 키 설정 후 이용할 수 있습니다." });
  try {
    const base = process.env.TAGO_BASE_URL || "https://apis.data.go.kr/1613000", city = process.env.TAGO_CITY_CODE || "38050";
    const url = new URL(`${base}/BusSttnInfoInqireService/getCrdntPrxmtSttnList`);
    url.searchParams.set("serviceKey", process.env.TAGO_SERVICE_KEY); url.searchParams.set("gpsLati", String(lat)); url.searchParams.set("gpsLong", String(lon)); url.searchParams.set("numOfRows", "10"); url.searchParams.set("pageNo", "1"); url.searchParams.set("_type", "json"); url.searchParams.set("cityCode", city);
    const data = await jsonFetch(url), raw = data?.response?.body?.items?.item || [], list = Array.isArray(raw) ? raw : [raw];
    res.json({ available: true, results: list.map((x) => ({ name: x.nodename || x.nodeName || "정류장", nodeId: x.nodeid || x.nodeId, message: "도착 API와 저상버스 정보는 TAGO 서비스별 제공 항목을 확인해 연동해야 합니다." })) });
  } catch (e) { res.status(502).json({ error: `버스 조회 실패: ${e.message}` }); }
});
app.post("/api/reports", (req, res) => {
  const x = req.body || {}; if (!Number.isFinite(Number(x.lat)) || !Number.isFinite(Number(x.lon))) return res.status(400).json({ error: "제보 위치를 선택해 주세요." });
  const report = { id: `${Date.now()}`, lat: Number(x.lat), lon: Number(x.lon), grade: x.grade === "" ? null : Number(x.grade), kerbHeightCm: x.kerbHeightCm === "" ? null : Number(x.kerbHeightCm), widthCm: x.widthCm === "" ? null : Number(x.widthCm), note: String(x.note || "").slice(0, 1000), photo: typeof x.photo === "string" && x.photo.startsWith("data:image/") ? x.photo : null, createdAt: new Date().toISOString() };
  reports.push(report); res.status(201).json({ ok: true, message: "제보를 접수했습니다. 현재 메모리에 임시 저장되며 서버 재시작 시 삭제됩니다." });
});
app.get("/api/reports", (_req, res) => res.json({ results: reports }));
app.listen(PORT, () => console.log(`턱없이: http://localhost:${PORT}`));
