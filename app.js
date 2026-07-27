/* ============================================================
 * 제주 2026.08 — 지도·반경 추천·물놀이
 *
 * 데이터는 data.js 의 window.JEJU 하나뿐. 서버도 로그인도 없다.
 * 상태(위치·반경·시각)는 두 탭이 공유한다 — 한 번 잡으면 둘 다 적용.
 * ============================================================ */

const DB = window.JEJU
const $ = (s) => document.querySelector(s)
const $$ = (s) => [...document.querySelectorAll(s)]

const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const WD_KO = { sun: '일', mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토' }
const CAT_KO = {
  restaurant: '식당', cafe: '카페', bakery: '베이커리', takeout: '포장·장보기',
  market: '시장', activity: '액티비티', attraction: '볼거리', shop: '소품·기념품',
  craft: '공방·체험',
}

// 체험하기 탭에 들어가는 분류
const CRAFT_CATS = new Set(['craft', 'activity', 'attraction'])
// 필터용 묶음
const CRAFT_GROUP = {
  공방: /공방|도예|향·캔들|가죽공예|목공|염색|유리공예|공예|클래스/,
  물: /다이빙|스노클링|서핑|카약|패들|요트|낚시|스쿠버/,
  뭍: /승마|카트|레이싱|짚라인|방탈출|클라이밍|서바이벌|농장체험|체험|투어|문화재|동굴|네컷사진/,
}

const state = {
  tab: 'eat',
  mode: 'now', // now = 지금 기준 / plan = 날짜·시간·위치를 직접 지정
  planned: false, // 먼저 알아보기에서 한 번이라도 확정했는지
  origin: null, // {lat, lng, label, auto}
  radius: 3,
  when: new Date(),
  cat: 'all',
  kind: 'all',
  craft: 'all',
  shop: 'all',
  spot: 'all', // 낚시 — 장소 유형(방파제/갯바위/낚시점)
  fish: 'all', // 낚시 — 어종
  q: '',
  list: 'all', // all / mine(=Pick) / work(=일하기 좋은)
  picking: false,
}

/* ══ 계산 ═══════════════════════════════════════════════ */

/** 두 지점 사이 km */
function dist(a, b) {
  const R = 6371
  const r = (d) => (d * Math.PI) / 180
  const dLat = r(b.lat - a.lat)
  const dLng = r(b.lng - a.lng)
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(x))
}
const km = (d) => (d < 1 ? `${Math.round(d * 1000)}m` : `${d.toFixed(1)}km`)

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number)
  return h * 60 + m
}
const fmt = (min) => {
  const m = ((min % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** "11:00-22:30" → {s,e} 분. 24시 초과 표기(19:00-26:00)를 그대로 살린다. */
function range(str) {
  if (!str || !str.includes('-')) return null
  const [a, b] = str.split('-')
  if (!/^\d{1,2}:\d{2}$/.test(a) || !/^\d{1,2}:\d{2}$/.test(b)) return null
  return { s: toMin(a), e: toMin(b) }
}

/** 매월 n번째 요일 휴무인지 */
function isNthClosed(p, d) {
  const wd = WD[d.getDay()]
  const nth = Math.floor((d.getDate() - 1) / 7) + 1
  return (p.closed_nth ?? []).some((r) => r.wd === wd && (r.nth ?? []).includes(nth))
}

/**
 * 지정 시각의 영업 상태.
 * 전날 자정을 넘겨 이어지는 영업(19:00-26:00)도 본다.
 */
function status(p, when) {
  const wd = WD[when.getDay()]
  const now = when.getHours() * 60 + when.getMinutes()

  if ((p.closed ?? []).includes(wd)) return { k: 'shut', t: '휴무일' }
  if (isNthClosed(p, when)) return { k: 'shut', t: '정기휴무' }

  const r = range(p.open)
  if (!r) return { k: 'unk', t: '시간 미상' }

  // 어제 열어서 오늘 새벽까지 이어지는 경우
  const prev = new Date(when.getTime() - 864e5)
  const prevOk = !(p.closed ?? []).includes(WD[prev.getDay()]) && !isNthClosed(p, prev)
  if (r.e > 1440 && prevOk && now < r.e - 1440) return { k: 'open', t: `영업중 · ${fmt(r.e)}까지` }

  if (now < r.s) return { k: 'shut', t: `${fmt(r.s)} 오픈` }
  if (now >= r.e) return { k: 'shut', t: '영업 종료' }

  const b = range(p.brk)
  if (b && now >= b.s && now < b.e) return { k: 'brk', t: `브레이크 · ${fmt(b.e)} 재개` }
  return { k: 'open', t: `영업중 · ${fmt(r.e)}까지` }
}

/* ── 물때 ─────────────────────────────────────────────── */

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** 해당 날짜·지점의 만조/간조. 없으면 null. */
function tideDay(station, when) {
  const st = DB.tide.stations?.[station]
  if (!st) return null
  return st.days.find((d) => d.date === ymd(when)) ?? null
}

/** 스팟 기준 물때 — 주 지점에 그 날짜가 없으면 예비 지점으로 넘어간다.
 *  (김녕항·한림항은 바다타임 자료라 여행 기간 8일치뿐이다) */
function tideFor(w, when) {
  const day = w.station ? tideDay(w.station, when) : null
  if (day) return { day, station: w.station, km: w.stationKm }
  if (w.stationAlt) {
    const alt = tideDay(w.stationAlt, when)
    if (alt) return { day: alt, station: w.stationAlt, km: w.stationAltKm }
  }
  return { day: null, station: w.station, km: w.stationKm }
}

/** 규칙(만조 전후 ±1.5h 등)을 시각 구간으로 편다 */
function playWindows(rule, day) {
  if (!day) return []
  const h = (rule?.hours ?? 1.5) * 60
  const type = rule?.type ?? 'around_high'
  const base = type.includes('low') ? day.low : day.high
  return (base ?? []).map(([t]) => {
    const m = toMin(t)
    if (type === 'before_high' || type === 'before_low') return { s: m - h, e: m, peak: m }
    if (type === 'after_high' || type === 'after_low') return { s: m, e: m + h, peak: m }
    return { s: m - h, e: m + h, peak: m }
  })
}

/* 일출·일몰.
 * 트립 파일에 든 값은 여행 기간(8/7~8/14)뿐이라, 그 밖의 날짜는 직접 계산한다.
 * NOAA 근사식 — 제주 위도에서 오차는 1~2분 수준이라 물놀이 시간 자르는 데엔 충분하다. */
function sunTimes(date, lat = 33.45, lng = 126.55) {
  const rad = Math.PI / 180
  const start = Date.UTC(date.getFullYear(), 0, 0)
  const doy = Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - start) / 864e5)
  const lngHour = lng / 15

  const calc = (rising) => {
    const t = doy + ((rising ? 6 : 18) - lngHour) / 24
    const M = 0.9856 * t - 3.289
    let L = M + 1.916 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 282.634
    L = (L + 360) % 360
    let RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad
    RA = (RA + 360) % 360
    RA += (Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90)
    RA /= 15
    const sinDec = 0.39782 * Math.sin(L * rad)
    const cosDec = Math.cos(Math.asin(sinDec))
    // 지평선 고도 -0.833° (대기 굴절 + 태양 반지름)
    const cosH = (Math.cos(90.833 * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad))
    if (cosH > 1 || cosH < -1) return null // 극야·백야
    const H = (rising ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad) / 15
    const T = H + RA - 0.06571 * t - 6.622
    const UT = ((T - lngHour) % 24 + 24) % 24
    return Math.round((UT + 9) * 60) % 1440 // KST
  }
  return { rise: calc(true), set: calc(false) }
}

/** 그 날의 일출·일몰. 트립 파일에 있으면 그걸, 없으면 계산값. */
function sunFor(when) {
  const rec = DB.tide.sun?.find((s) => s.date === ymd(when))
  return rec ? { rise: toMin(rec.rise), set: toMin(rec.set) } : sunTimes(when)
}

/** 낮 시간(일출~일몰)과 겹치는 구간만 남긴다 — 밤에 물놀이는 안 한다 */
function daylightClip(wins, when) {
  const sun = sunFor(when)
  if (sun.rise == null || sun.set == null) return wins
  return wins
    .map((w) => ({ ...w, s: Math.max(w.s, sun.rise), e: Math.min(w.e, sun.set) }))
    .filter((w) => w.e - w.s >= 30)
}

/** 지금이 만조/간조 기준 어디쯤인지 한 줄로 */
function tideNow(day, when) {
  if (!day) return null
  const now = when.getHours() * 60 + when.getMinutes()
  const evts = [
    ...(day.high ?? []).map(([t, cm]) => ({ t: toMin(t), cm, k: '만조' })),
    ...(day.low ?? []).map(([t, cm]) => ({ t: toMin(t), cm, k: '간조' })),
  ].sort((a, b) => a.t - b.t)
  if (!evts.length) return null
  const next = evts.find((e) => e.t >= now)
  const prev = [...evts].reverse().find((e) => e.t < now)
  const bits = []
  if (prev) bits.push(`${prev.k} ${fmt(prev.t)} 지남`)
  if (next) {
    const gap = next.t - now
    bits.push(`${next.k} ${fmt(next.t)}${gap < 180 ? ` (${Math.floor(gap / 60) ? `${Math.floor(gap / 60)}시간 ` : ''}${gap % 60}분 뒤)` : ''}`)
  }
  return { line: bits.join(' · '), moon: day.moon ?? null }
}

/* ── 낚시 ─────────────────────────────────────────────────
 *
 * 물놀이와 정반대 논리다. 물놀이는 만조 전후의 "멈춘 물"이 좋고,
 * 낚시는 들물·날물이 붙어 흐르는 구간이 입질이다. 정조엔 오히려 잘 안 나온다.
 * 그래서 playWindows() 를 재사용하지 않고 따로 계산한다. */

const FISH = DB.fishing ?? { spots: [], shops: [], species: [], rules: null }
const SPECIES = Object.fromEntries((FISH.species ?? []).map((s) => [s.id, s]))

/** 만조·간조를 시간순으로 세워 들물/날물 구간으로 자른다.
 *  반조석 근사로 구간 한가운데가 유속 최대 — 그게 곧 입질 피크다.
 *
 *  앞뒤 날을 같이 받는 이유: 자료가 "그 날짜 안에 든 것" 만 담고 있어서
 *  저녁 만조 뒤의 날물은 다음 날 간조에 가서야 끝난다. 하루만 보면
 *  밤 시간대가 통째로 비어 한치·갈치가 늘 "물때 없음" 이 된다. */
function tideRuns(day, prev, next) {
  if (!day) return []
  const ev = (d, off) => (!d ? [] : [
    ...(d.high ?? []).map(([t, cm]) => ({ t: toMin(t) + off, cm, k: 'high' })),
    ...(d.low ?? []).map(([t, cm]) => ({ t: toMin(t) + off, cm, k: 'low' })),
  ])
  const evts = [...ev(prev, -1440), ...ev(day, 0), ...ev(next, 1440)].sort((a, b) => a.t - b.t)
  const runs = []
  for (let i = 0; i + 1 < evts.length; i++) {
    const a = evts[i]
    const b = evts[i + 1]
    if (a.k === b.k) continue // 같은 종류가 연달아 오면 자료가 빈 구간이다
    const hours = Math.max(0.5, (b.t - a.t) / 60)
    runs.push({
      dir: a.k === 'low' ? 'flood' : 'ebb', // 간조→만조 = 들물
      s: a.t,
      e: b.t,
      peak: Math.round((a.t + b.t) / 2),
      drop: Math.abs(b.cm - a.cm),
      speed: Math.abs(b.cm - a.cm) / hours, // cm/h
    })
  }
  // 오늘 화면에 걸치는 것만. 뒤로는 새벽 3시까지만 — 밤낚시가 자정은 넘어도 그 뒤는 아니다
  return runs.filter((r) => r.e > 0 && r.s < 1440 + 180)
}

/** 그 스팟·그 날짜의 들물/날물 구간 (앞뒤 날을 이어서) */
function runsFor(x, when) {
  const { day, station } = tideFor(x, when)
  const days = DB.tide.stations?.[station]?.days ?? []
  const i = days.findIndex((d) => d.date === ymd(when))
  return tideRuns(day, i > 0 ? days[i - 1] : null, i >= 0 ? days[i + 1] : null)
}

const DIR_KO = { flood: '들물', ebb: '날물' }

/* 유속은 절대값으로 못 잰다. 제주는 북쪽(제주항)이 조차가 작고 남서쪽(모슬포)이 크다.
 * 같은 20cm/h 라도 한 곳에선 센 물이고 다른 곳에선 죽은 물이다.
 * 그래서 그 지점 자기 자료 전체와 견줘서 3등분한다. */
const _speedRef = {}
function speedRef(station) {
  if (_speedRef[station]) return _speedRef[station]
  const all = []
  for (const d of DB.tide.stations?.[station]?.days ?? []) {
    for (const r of tideRuns(d)) all.push(r.speed)
  }
  all.sort((a, b) => a - b)
  const at = (p) => all[Math.min(all.length - 1, Math.floor(all.length * p))]
  return (_speedRef[station] = all.length >= 6 ? { lo: at(0.33), hi: at(0.66) } : null)
}
function speedGrade(v, station) {
  const ref = station ? speedRef(station) : null
  if (!ref || ref.hi <= ref.lo) return v >= 40 ? '강' : v >= 25 ? '보통' : '약'
  return v >= ref.hi ? '강' : v <= ref.lo ? '약' : '보통'
}

/** 오늘 조차가 그 지점 기준 사리급인지 조금급인지.
 *  지점마다 조차 크기가 다르다(제주는 작고 모슬포는 크다). 절대값으로는 못 재서
 *  그 지점 자기 자료 안에서의 위치로 본다. */
function moonGrade(station, day) {
  const dropOf = (d) => {
    const his = (d.high ?? []).map(([, cm]) => cm)
    const los = (d.low ?? []).map(([, cm]) => cm)
    return his.length && los.length ? Math.max(...his) - Math.min(...los) : null
  }
  const mine = day ? dropOf(day) : null
  const all = (DB.tide.stations?.[station]?.days ?? []).map(dropOf).filter((v) => v != null)
  if (mine == null || all.length < 4) return null
  const min = Math.min(...all)
  const max = Math.max(...all)
  const ratio = max === min ? 0.5 : (mine - min) / (max - min)
  return {
    drop: Math.round(mine),
    ratio,
    label: ratio >= 0.66 ? '사리급' : ratio <= 0.33 ? '조금급' : '중간물',
  }
}

/** 어종 하나의 입질 시간대 — 시간대(밤/해질녘/낮)와 물때 선호의 교집합.
 *  runs 는 runsFor() 가 만든 들물/날물 구간. */
function biteWindows(sp, runs, when, station) {
  const sun = sunFor(when)
  const rise = sun.rise ?? 5 * 60
  const set = sun.set ?? 19 * 60

  let slots
  if (sp.time === 'night') {
    slots = [{ s: set, e: set + (sp.window?.hours ?? 4) * 60, why: '일몰 후' }]
  } else if (sp.time === 'dawn_dusk') {
    slots = [
      { s: rise - 60, e: rise + 90, why: '해뜰녘' },
      { s: set - 90, e: set + 60, why: '해질녘' },
    ]
  } else if (sp.time === 'day') {
    slots = [{ s: rise, e: set, why: '낮' }]
  } else {
    slots = [{ s: 0, e: 1440, why: '' }]
  }

  const withSt = runs.map((r) => ({ ...r, station }))
  const pref = sp.tide && sp.tide !== 'any' ? withSt.filter((r) => r.dir === sp.tide) : withSt
  if (!pref.length) return slots.map((x) => ({ ...x, tide: null }))

  /* 들물 전체(7시간)를 "입질 시간" 이라고 내밀면 아무 말도 안 한 것과 같다.
   * 유속이 가장 붙는 구간 한가운데 ±1.5시간으로 좁힌다.
   * 좁혀서 시간대와 안 겹치면 구간 전체로, 그래도 없으면 시간대만. */
  const pick = (narrow) => {
    const out = []
    for (const slot of slots) {
      for (const r of pref) {
        const rs = narrow ? Math.max(r.s, r.peak - 90) : r.s
        const re = narrow ? Math.min(r.e, r.peak + 90) : r.e
        const s = Math.max(slot.s, rs)
        const e = Math.min(slot.e, re)
        if (e - s >= 45) out.push({ s, e, why: slot.why, tide: r })
      }
    }
    // 들물이 끝나고 날물이 이어지면 창이 딱 맞닿는다 — "19:38–22:11, 22:11–23:38" 로
    // 두 줄 내밀 이유가 없으니 붙여서 하나로 만든다. 대표 물때는 유속이 센 쪽.
    out.sort((a, b) => a.s - b.s)
    const merged = []
    for (const w of out) {
      const last = merged[merged.length - 1]
      if (last && w.s <= last.e + 20) {
        last.e = Math.max(last.e, w.e)
        if ((w.tide?.speed ?? 0) > (last.tide?.speed ?? 0)) last.tide = w.tide
      } else merged.push({ ...w })
    }
    return merged.slice(0, 3)
  }

  const narrow = pick(true)
  if (narrow.length) return narrow
  const wide = pick(false)
  if (wide.length) return wide
  // 겹치는 게 없으면 시간대만이라도 준다 — 한치처럼 물때를 덜 타는 어종이 있다
  return slots.map((x) => ({ ...x, tide: null }))
}

/** 입질 창 밑에 붙는 한 줄 — 물때가 안 겹치면 그렇다고 말한다 */
function biteWhy(sp, w) {
  const bits = [w?.why].filter(Boolean)
  if (w?.tide) bits.push(`${DIR_KO[w.tide.dir]} 유속 ${speedGrade(w.tide.speed, w.tide.station)}`)
  else if (sp.tide && sp.tide !== 'any') bits.push(`오늘은 이 시간에 ${DIR_KO[sp.tide]}이 안 걸립니다`)
  else bits.push('물때 영향 적음')
  return bits.join(' · ')
}

/** 그 포인트에서 지금 노릴 만한 어종 — 필터가 걸려 있으면 그것만 */
function spotSpecies(sp) {
  const ids = state.fish !== 'all' ? (sp.species ?? []).filter((id) => id === state.fish) : (sp.species ?? [])
  return ids.map((id) => SPECIES[id]).filter(Boolean)
}

/* ══ 지도 ═══════════════════════════════════════════════ */

const map = L.map('map', { zoomControl: false, attributionControl: true })
  .setView([33.45, 126.55], 10)
L.control.zoom({ position: 'bottomleft' }).addTo(map)
// 밝은 회색 톤 타일. OSM 기본 타일에 CSS 필터를 씌우는 것보다 글자가 훨씬 잘 읽힌다
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  maxZoom: 20,
  subdomains: 'abcd',
  attribution: '&copy; OpenStreetMap &copy; CARTO',
}).addTo(map)

let markers = []
let originMarker = null
let radiusCircle = null

function clearMarkers() {
  markers.forEach((m) => map.removeLayer(m))
  markers = []
}

function pinIcon(cls, big) {
  const size = big ? 16 : 11
  return L.divIcon({
    className: '',
    html: `<div class="pin ${cls}" style="width:${size}px;height:${size}px"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

function drawMarkers(items) {
  clearMarkers()
  for (const it of items) {
    const cls = state.tab === 'water' ? it.kind
      : state.tab === 'fish' ? (it.warns?.some((w) => w.level === 'danger') ? 'fish-bad' : `fish-${it.type}`)
        : (it.cat === 'shop' ? 'shop' : it.cat)
    const m = L.marker([it.lat, it.lng], {
      icon: pinIcon(cls, !!it.__near),
      // 가까운 곳을 위로
      zIndexOffset: it.__near ? 500 : 0,
    })
    m.on('click', () => openDetail(it))
    m.bindTooltip(it.name, { direction: 'top', offset: [0, -8], opacity: .9 })
    m.addTo(map)
    markers.push(m)
  }
}

function drawOrigin() {
  if (originMarker) { map.removeLayer(originMarker); originMarker = null }
  if (radiusCircle) { map.removeLayer(radiusCircle); radiusCircle = null }
  if (!state.origin) return
  originMarker = L.marker([state.origin.lat, state.origin.lng], {
    icon: L.divIcon({ className: '', html: '<div class="origin-dot" style="width:16px;height:16px"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
    zIndexOffset: 1000,
  }).addTo(map)
  radiusCircle = L.circle([state.origin.lat, state.origin.lng], {
    radius: state.radius * 1000,
    color: '#2f81f7', weight: 1, fillColor: '#2f81f7', fillOpacity: .07,
  }).addTo(map)
}

/* 줌에 따라 핀 크기를 바꾼다.
 * 섬 전체가 보이는 줌에서는 300개 넘는 핀이 뭉치므로 작게, 확대하면 크게. */
function syncPinScale() {
  const z = map.getZoom()
  const el = map.getContainer()
  el.classList.toggle('z-far', z < 12)
  el.classList.toggle('z-near', z >= 15)
}
map.on('zoomend', syncPinScale)

/* ══ 목록 ═══════════════════════════════════════════════ */

/** 탭이 담당하는 원본 목록 */
function tabSource(tab = state.tab) {
  if (tab === 'water') return DB.water
  if (tab === 'fish') return [...FISH.spots, ...FISH.shops]
  return DB.places
}

function currentItems() {
  let items = tabSource().slice()

  if (state.tab === 'fish') {
    if (state.spot !== 'all') items = items.filter((s) => s.type === state.spot)
    // 어종을 고르면 낚시점은 자연히 빠진다 — 어종이 없으니까
    if (state.fish !== 'all') items = items.filter((s) => (s.species ?? []).includes(state.fish))
    if (state.q.trim()) {
      const q = state.q.trim().toLowerCase()
      items = items.filter((s) => `${s.name} ${s.addr ?? ''} ${s.area ?? ''}`.toLowerCase().includes(q))
    }
  } else if (state.tab !== 'water') {
    // 범위밖(서귀포 등)은 반경 추천에서 뺀다 — DB엔 남아 있다
    items = items.filter((p) => !p.out_of_scope)
    // 탭마다 담당하는 분류가 다르다
    items = items.filter((p) =>
      state.tab === 'craft' ? CRAFT_CATS.has(p.cat)
        : state.tab === 'shop' ? p.cat === 'shop'
          : !CRAFT_CATS.has(p.cat) && p.cat !== 'shop')
    if (state.list === 'mine') items = items.filter((p) => p.src === 'mine')
    // 콘센트 있는 자리에서 노트북을 펴려는 용도. 태그는 places.json 에서 손으로 붙인다
    if (state.list === 'work') items = items.filter((p) => (p.tags ?? []).includes('일하기좋은'))
    if (state.tab === 'eat' && state.cat !== 'all') {
      items = items.filter((p) =>
        state.cat === 'etc'
          ? !['restaurant', 'cafe', 'bakery'].includes(p.cat)
          : p.cat === state.cat)
    }
    if (state.tab === 'shop' && state.shop !== 'all') {
      items = items.filter((p) => p.sub === state.shop)
    }
    if (state.tab === 'craft' && state.craft !== 'all') {
      const re = CRAFT_GROUP[state.craft]
      items = items.filter((p) => re.test(`${p.sub ?? ''} ${p.cat}`))
    }
  } else {
    if (state.kind !== 'all') items = items.filter((w) => w.kind === state.kind)
    if (state.q.trim()) {
      const q = state.q.trim().toLowerCase()
      items = items.filter((w) => `${w.name} ${w.addr ?? ''} ${w.area ?? ''}`.toLowerCase().includes(q))
    }
  }

  if (state.origin) {
    items = items
      .map((p) => ({ ...p, __d: dist(state.origin, p) }))
      .filter((p) => p.__d <= state.radius)
      .sort((a, b) => a.__d - b.__d)
      .map((p) => ({ ...p, __near: true }))
  } else {
    items = items.map((p) => ({ ...p, __d: null }))
    // 위치가 없으면 검색·필터 결과만 이름순
    items.sort((a, b) => a.name.localeCompare(b.name, 'ko'))
  }
  return items
}

/** "카페 · 카페 · 애월읍" 처럼 분류와 세부가 겹치면 하나만 남긴다 */
function kindLine(p) {
  const cat = CAT_KO[p.cat] ?? p.cat
  const bits = [cat]
  if (p.sub && p.sub !== cat) bits.push(p.sub)
  if (p.area) bits.push(p.area)
  return bits.join(' · ')
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const thumb = (url, fallback) =>
  url ? `<img class="thumb" loading="lazy" src="${esc(url)}" alt="">`
      : `<div class="thumb ph">${fallback}</div>`

function hoursLine(p) {
  const st = status(p, state.when)
  const bits = []
  if (p.open) bits.push(p.open.replace('-', '–'))
  if (p.brk) bits.push(`브레이크 ${p.brk.replace('-', '–')}`)
  if (p.closed?.length) bits.push(`${p.closed.map((d) => WD_KO[d]).join('·')} 휴무`)
  return `<span class="pill ${st.k}">${esc(st.t)}</span> <span>${esc(bits.join(' · ') || '영업시간 미상')}</span>`
}

/** 체험하기 탭 카드 본문 — 소개문 대신 가격.
 *  체험은 "얼마인지"가 고를 때 제일 먼저 궁금하다. 먹거리는 소개문 그대로 둔다.
 *  가격 정보가 아예 없으면 소개문으로 되돌아간다. */
function priceLine(p) {
  const r = p.detail?.priceRange
  const sig = p.detail?.signature
  const unit = p.cat === 'shop' ? '상품' : p.cat === 'craft' ? '1인' : '1인'
  const rows = []
  if (r && r.min !== r.max) rows.push(`<span class="price">${unit} ${won(r.min)}~${won(r.max)}</span>`)
  else if (sig?.price) rows.push(`<span class="price">${unit} ${won(sig.price)}</span>`)
  if (sig?.name) {
    rows.push(`<span class="sig">${esc(sig.name)}${sig.price ? ` <b>${won(sig.price)}</b>` : ''}</span>`)
  }
  if (!rows.length) return `<p class="blurb">${esc(p.blurb ?? '')}</p>`
  return `<p class="prices">${rows.join('')}</p>`
}

function cardEat(p) {
  // Pick = 사용자가 직접 넣은 곳. 이름 바로 옆에 붙여 눈에 먼저 들어오게 한다
  const pick = p.src === 'mine' ? '<span class="pill mine">⭐ Pick</span>' : ''
  // 콘센트 있는 자리를 찾는 사람에겐 이게 분류보다 먼저 보여야 한다
  const work = (p.tags ?? []).includes('일하기좋은') ? '<span class="pill work">💻 일하기 좋은</span>' : ''
  const tags = []
  if (p.src === 'claude') tags.push('<span class="pill rec">추천받음</span>')
  if (p.conf === 'verified') tags.push('<span class="pill">네이버 확인</span>')
  return `<article class="card" data-id="${p.id}">
    ${thumb(p.photos[0], state.tab === 'shop' ? '🎁' : state.tab === 'craft' ? '🧑‍🎨' : '🍽')}
    <div>
      <h3>${esc(p.name)} ${pick}${work} ${p.__d != null ? `<span class="dist">${km(p.__d)}</span>` : ''}</h3>
      <p class="meta">${esc(kindLine(p))}${p.score ? ` · ★${p.score}` : ''}</p>
      ${state.tab === 'craft' ? priceLine(p) : `<p class="blurb">${esc(p.blurb ?? '')}</p>`}
      <p class="hours">${hoursLine(p)}</p>
      <p class="tagrow" style="margin:5px 0 0">${tags.join('')}</p>
    </div>
  </article>`
}

function cardWater(w) {
  const { day, station, km: stKm } = tideFor(w, state.when)
  const wins = daylightClip(playWindows(w.rule, day), state.when)
  const now = tideNow(day, state.when)
  const tideBox = day
    ? `<div class="tide">
         <div class="best">놀기 좋은 시간 ${wins.length ? wins.map((v) => `${fmt(v.s)}–${fmt(v.e)}`).join(', ') : '낮 시간대 없음'}</div>
         <div class="now">${esc(now?.line ?? '')}${now?.moon ? ` · ${esc(now.moon)}` : ''} <span class="muted">(${esc(station)} 기준${stKm != null ? ` ${stKm}km` : ''})</span></div>
       </div>`
    : `<div class="tide"><div class="now">이 날짜는 물때 자료가 없어요 (${esc(DB.tide.range.start)} ~ ${esc(DB.tide.range.end)}만 있음)</div></div>`
  return `<article class="card" data-id="${w.id}">
    ${thumb(w.photos[0], '🌊')}
    <div>
      <h3>${esc(w.name)} ${w.__d != null ? `<span class="dist">${km(w.__d)}</span>` : ''}</h3>
      <p class="meta"><span class="pill kind">${esc(w.kind)}</span> ${esc(w.addr ?? '')}</p>
      ${tideBox}
    </div>
  </article>`
}

/* ── 낚시 카드 ─────────────────────────────────────────────
 * 본문이 소개문(맛집)도 가격(체험)도 놀기좋은시간(물놀이)도 아닌
 * "입질 시간대"다. 어종을 고르면 그 어종 기준으로 바뀐다. */

const warnHtml = (warns) => (warns ?? [])
  .map((w) => `<div class="warn ${w.level === 'danger' ? 'bad' : ''}">${w.level === 'danger' ? '⛔' : '⚠️'} ${esc(w.text)}</div>`)
  .join('')

function cardShop(s) {
  return `<article class="card" data-id="${s.id}">
    ${thumb(s.photos[0], '🧰')}
    <div>
      <h3>${esc(s.name)} ${s.__d != null ? `<span class="dist">${km(s.__d)}</span>` : ''}</h3>
      <p class="meta"><span class="pill kind">낚시점</span> ${esc(s.addr ?? '')}</p>
      <p class="blurb">${s.phone ? `📞 ${esc(s.phone)}` : '미끼·채비 구입'}${s.score ? ` · ★${s.score}` : ''}</p>
    </div>
  </article>`
}

function cardFish(x) {
  if (x.type === '낚시점') return cardShop(x)

  const { day, station } = tideFor(x, state.when)
  const runs = runsFor(x, state.when)
  const now = state.when.getHours() * 60 + state.when.getMinutes()
  const cur = runs.find((r) => now >= r.s && now < r.e)
  const moon = moonGrade(station, day)

  let box
  if (!day) {
    box = `<div class="now">이 날짜는 물때 자료가 없어요 (${esc(DB.tide.range.start)} ~ ${esc(DB.tide.range.end)}만 있음)</div>`
  } else if (state.fish !== 'all' && SPECIES[state.fish]) {
    const sp = SPECIES[state.fish]
    const wins = biteWindows(sp, runs, state.when, station)
    box = `<div class="best">${esc(sp.name)} 입질 ${wins.map((w) => `${fmt(w.s)}–${fmt(w.e)}`).join(', ')}</div>
      <div class="now">${esc(biteWhy(sp, wins[0]))}${moon ? ` · ${esc(moon.label)}` : ''}</div>`
  } else {
    const ahead = runs.filter((r) => r.e > now).slice(0, 2)
    box = `<div class="best">${ahead.length
      ? ahead.map((r) => `${DIR_KO[r.dir]} ${fmt(r.s)}→${fmt(r.e)}`).join(' · ')
      : '오늘 물때 끝'}</div>
      <div class="now">${cur ? `지금 ${DIR_KO[cur.dir]} · 유속 ${speedGrade(cur.speed, station)}` : '지금은 정조 부근'}${moon ? ` · ${esc(moon.label)} 조차 ${moon.drop}cm` : ''}</div>`
  }

  // 어종을 고른 상태면 물때 박스가 이미 그 어종 얘기다 — 밑에 또 쓰지 않는다
  const sps = state.fish !== 'all' ? '' : spotSpecies(x).slice(0, 4).map((s) => esc(s.name)).join(' · ')

  return `<article class="card" data-id="${x.id}">
    ${thumb(x.photos[0], '🎣')}
    <div>
      <h3>${esc(x.name)} ${x.__d != null ? `<span class="dist">${km(x.__d)}</span>` : ''}</h3>
      <p class="meta"><span class="pill kind">${esc(x.type)}</span><span class="pill lv">${esc(x.level)}</span>
        ${x.night_ok ? '<span class="pill night">밤 가능</span>' : ''}
        ${x.also_swim ? '<span class="pill swim">물놀이터</span>' : ''}
        ${esc(x.area ?? '')}</p>
      <div class="tide">${box}</div>
      ${sps ? `<p class="blurb">노려볼 어종 ${sps}</p>` : ''}
      ${warnHtml(x.warns)}
    </div>
  </article>`
}

function render() {
  const items = currentItems()
  const list = $('#list')
  $('#count').textContent = state.origin
    ? `반경 ${state.radius}km · ${items.length}곳`
    : `${items.length}곳`
  $('#origin-label').textContent = state.origin ? state.origin.label : '위치를 정하면 거리순으로 정렬돼요'

  const card = state.tab === 'water' ? cardWater : state.tab === 'fish' ? cardFish : cardEat
  list.innerHTML = items.length
    ? items.map(card).join('')
    : `<p class="empty">${state.list !== 'all' && state.origin
        ? `반경 ${state.radius}km 안에 ${state.list === 'mine' ? 'Pick 한' : '일하기 좋은'} 곳이 없어요. 반경을 넓혀보세요.`
        : state.origin ? `반경 ${state.radius}km 안에 없어요. 반경을 넓혀보세요.` : '조건에 맞는 곳이 없어요.'}</p>`

  drawMarkers(items.length ? items : tabSource())
  drawOrigin()
}

/* ══ 상세 ═══════════════════════════════════════════════ */

const won = (n) => (n ? `${n.toLocaleString('ko-KR')}원` : '')

function detailEat(p) {
  const d = p.detail ?? {}
  const st = status(p, state.when)
  const sec = (title, html) => (html ? `<div class="sec"><h4>${title}</h4>${html}</div>` : '')

  const links = [
    p.naver_url ? `<a class="nv" href="${esc(p.naver_url)}" target="_blank" rel="noopener">네이버 플레이스</a>` : '',
    p.kakao_url ? `<a class="kk" href="${esc(p.kakao_url)}" target="_blank" rel="noopener">카카오맵</a>` : '',
    ...(p.links ?? []).map((l) => {
      const ig = /인스타/.test(l.type)
      return `<a class="${ig ? 'ig' : ''}" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(ig ? '인스타그램' : l.type)}</a>`
    }),
    ...(p.related ?? []).map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)}</a>`),
  ].filter(Boolean).join('')

  const menus = (p.menus ?? []).filter((m) => m.name)
  const tags = (p.tags ?? []).filter((t) => t !== '범위밖')

  return `
    <h2>${esc(p.name)} ${p.src === 'mine' ? '<span class="pill mine">⭐ Pick</span>' : ''}</h2>
    <p class="sub">${esc(kindLine(p))}
      ${p.score ? ` · ★${p.score} (${p.reviews ?? 0})` : ''}
      ${p.__d != null ? ` · 여기서 ${km(p.__d)}` : ''}</p>

    ${p.photos.length ? `<div class="gal">${p.photos.map((u) => `<img loading="lazy" src="${esc(u)}" alt="">`).join('')}</div>` : ''}
    ${p.photo_note ? `<p class="muted" style="margin:-8px 0 14px">사진 출처: ${esc(p.photo_note)}</p>` : ''}

    ${sec('영업', `<dl class="kv">
      <dt>지금</dt><dd><span class="pill ${st.k}">${esc(st.t)}</span></dd>
      <dt>영업시간</dt><dd>${esc(p.open ?? '미상')}${p.open && range(p.open)?.e > 1440 ? ' <span class="muted">(자정 넘김)</span>' : ''}</dd>
      ${p.brk ? `<dt>브레이크</dt><dd>${esc(p.brk)}</dd>` : ''}
      <dt>휴무</dt><dd>${p.closed?.length ? esc(p.closed.map((x) => WD_KO[x]).join('·')) + '요일' : (p.closed ? '연중무휴' : '미확인')}
        ${(p.closed_nth ?? []).map((r) => ` · 매월 ${r.nth.join('·')}째주 ${WD_KO[r.wd] ?? r.wd}`).join('')}</dd>
      ${p.phone ? `<dt>전화</dt><dd><a href="tel:${esc(p.phone)}" style="color:var(--accent)">${esc(p.phone)}</a></dd>` : ''}
      <dt>주소</dt><dd>${esc(p.addr ?? '-')}</dd>
    </dl>`)}

    ${sec('어떤 곳', [
      d.head ? `<p>${esc(d.head)}</p>` : '',
      d.note ? `<p>${esc(d.note)}</p>` : '',
      (d.micro ?? []).length ? `<p class="muted">“${esc(d.micro.join('” · “'))}”</p>` : '',
      d.owner ? `<p class="muted" style="font-size:13px">사장님 소개 — ${esc(d.owner)}</p>` : '',
      d.directions ? `<p class="muted" style="font-size:13px">찾아가는 길 — ${esc(d.directions)}</p>` : '',
    ].join(''))}

    ${sec('메뉴', menus.length ? menus.map((m) => `
      <div class="menu">
        <div class="nm"><b>${esc(m.name)}</b>${m.recommend ? '<span class="rec">추천</span>' : ''}
          ${m.desc ? `<small>${esc(m.desc)}</small>` : ''}</div>
        <div class="pr">${esc(m.price_text ?? '') || won(m.price)}</div>
      </div>`).join('')
      + (d.priceRange ? `<p class="muted" style="margin-top:8px">가격대 ${won(d.priceRange.min)} ~ ${won(d.priceRange.max)}</p>` : '')
      : '')}

    ${sec('편의', (d.conveniences ?? []).length ? `<p class="tagrow">${d.conveniences.map((c) => `<span class="pill">${esc(c)}</span>`).join('')}</p>` : '')}
    ${sec('태그', tags.length ? `<p class="tagrow">${tags.map((t) => `<span class="pill">${esc(t)}</span>`).join('')}</p>` : '')}
    ${sec('바로가기', links ? `<div class="links">${links}</div>` : '<p class="muted">등록된 외부 링크가 없어요.</p>')}
    ${(p.menu_images ?? []).length ? sec('메뉴판', `<div class="gal">${p.menu_images.map((u) => `<img loading="lazy" src="${esc(u)}" alt="">`).join('')}</div>`) : ''}
  `
}

function detailWater(w) {
  const { day, station, km: stKm } = tideFor(w, state.when)
  const wins = daylightClip(playWindows(w.rule, day), state.when)
  const now = tideNow(day, state.when)
  const sec = (t, h) => (h ? `<div class="sec"><h4>${t}</h4>${h}</div>` : '')
  const links = [
    w.naver_url ? `<a class="nv" href="${esc(w.naver_url)}" target="_blank" rel="noopener">네이버 플레이스</a>` : '',
    w.kakao_url ? `<a class="kk" href="${esc(w.kakao_url)}" target="_blank" rel="noopener">카카오맵</a>` : '',
  ].filter(Boolean).join('')

  return `
    <h2>${esc(w.name)}</h2>
    <p class="sub"><span class="pill kind">${esc(w.kind)}</span> ${esc(w.area ?? '')}
      ${w.score ? ` · ★${w.score} (${w.reviews ?? 0})` : ''}
      ${w.__d != null ? ` · 여기서 ${km(w.__d)}` : ''}</p>

    ${w.photos.length ? `<div class="gal">${w.photos.map((u) => `<img loading="lazy" src="${esc(u)}" alt="">`).join('')}</div>` : ''}

    ${sec('물때', day ? `<div class="tide">
        <div class="best">놀기 좋은 시간 ${wins.length ? wins.map((v) => `${fmt(v.s)}–${fmt(v.e)}`).join(', ') : '낮 시간대 없음'}</div>
        <div class="now">${esc(now?.line ?? '')}${now?.moon ? ` · ${esc(now.moon)}` : ''}</div>
      </div>
      <dl class="kv" style="margin-top:10px">
        <dt>만조</dt><dd>${(day.high ?? []).map(([t, cm]) => `${t} (${cm}cm)`).join(' · ')}</dd>
        <dt>간조</dt><dd>${(day.low ?? []).map(([t, cm]) => `${t} (${cm}cm)`).join(' · ')}</dd>
        <dt>기준</dt><dd>${esc(station)}${stKm != null ? ` <span class="muted">(${stKm}km 떨어짐)</span>` : ''}
          ${DB.tide.stations[station]?.source ? `<br><span class="muted">${esc(DB.tide.stations[station].source)}</span>` : ''}</dd>
        <dt>규칙</dt><dd>${esc(w.rule?.note ?? (w.rule?.type === 'before_high' ? `만조 ${w.rule.hours}시간 전` : `만조 전후 ${w.rule?.hours ?? 1.5}시간`))}</dd>
      </dl>`
      : `<p class="muted">물때 자료는 여행 기간(${DB.tide.range.start} ~ ${DB.tide.range.end})만 넣어뒀어요.</p>`)}

    ${sec('주의', DB.tide.safety ? `<p class="muted">${esc(DB.tide.safety)}</p>` : '')}
    ${sec('위치', `<dl class="kv"><dt>주소</dt><dd>${esc(w.addr ?? '-')}</dd></dl>`)}
    ${w.micro ? sec('한 줄', `<p class="muted">“${esc(w.micro)}”</p>`) : ''}
    ${sec('바로가기', links ? `<div class="links">${links}</div>` : '<p class="muted">등록된 외부 링크가 없어요.</p>')}
  `
}

/* ── 낚시 상세 ───────────────────────────────────────────── */

function detailShop(s) {
  const sec = (t, h) => (h ? `<div class="sec"><h4>${t}</h4>${h}</div>` : '')
  const links = [
    s.naver_url ? `<a class="nv" href="${esc(s.naver_url)}" target="_blank" rel="noopener">네이버 플레이스</a>` : '',
    s.kakao_url ? `<a class="kk" href="${esc(s.kakao_url)}" target="_blank" rel="noopener">카카오맵</a>` : '',
  ].filter(Boolean).join('')
  return `
    <h2>${esc(s.name)}</h2>
    <p class="sub"><span class="pill kind">낚시점</span> ${esc(s.area ?? '')}
      ${s.score ? ` · ★${s.score} (${s.reviews ?? 0})` : ''}
      ${s.__d != null ? ` · 여기서 ${km(s.__d)}` : ''}</p>
    ${s.photos.length ? `<div class="gal">${s.photos.map((u) => `<img loading="lazy" src="${esc(u)}" alt="">`).join('')}</div>` : ''}
    ${sec('연락', `<dl class="kv">
      <dt>주소</dt><dd>${esc(s.addr ?? '-')}</dd>
      ${s.phone ? `<dt>전화</dt><dd><a href="tel:${esc(s.phone)}">${esc(s.phone)}</a></dd>` : ''}
    </dl>`)}
    ${sec('메모', '<p class="muted">영업시간은 수집하지 않았습니다. 새벽 출조 전이라면 전화로 확인하세요.</p>')}
    ${sec('바로가기', links ? `<div class="links">${links}</div>` : '<p class="muted">등록된 외부 링크가 없어요.</p>')}
  `
}

function detailFish(x) {
  if (x.type === '낚시점') return detailShop(x)

  const { day, station, km: stKm } = tideFor(x, state.when)
  const runs = runsFor(x, state.when)
  const moon = moonGrade(station, day)
  const sec = (t, h) => (h ? `<div class="sec"><h4>${t}</h4>${h}</div>` : '')
  const links = [
    x.naver_url ? `<a class="nv" href="${esc(x.naver_url)}" target="_blank" rel="noopener">네이버 플레이스</a>` : '',
    x.kakao_url ? `<a class="kk" href="${esc(x.kakao_url)}" target="_blank" rel="noopener">카카오맵</a>` : '',
  ].filter(Boolean).join('')

  // 어종별 입질 시간대 — 필터가 걸려 있어도 상세에선 전부 보여준다
  const all = (x.species ?? []).map((id) => SPECIES[id]).filter(Boolean)
  const bites = !day ? '' : all.map((sp) => {
    const wins = biteWindows(sp, runs, state.when, station)
    const lim = sp.size_limit?.cm ? ` · ${sp.size_limit.cm}cm 이상${sp.size_limit.measure ? `(${sp.size_limit.measure})` : ''}만` : ''
    return `<div class="bite">
      <div class="bite-h"><b>${esc(sp.name)}</b> <span class="pill lv">${esc(sp.level)}</span>
        <span class="bite-t">${wins.map((w) => `${fmt(w.s)}–${fmt(w.e)}`).join(', ')}</span></div>
      <div class="muted">${esc(biteWhy(sp, wins[0]) + lim)}</div>
      <div class="muted">${esc(sp.gear)} / ${esc(sp.bait)}</div>
      <div class="tipline">${esc(sp.tip)}</div>
    </div>`
  }).join('')

  return `
    <h2>${esc(x.name)}</h2>
    <p class="sub"><span class="pill kind">${esc(x.type)}</span><span class="pill lv">${esc(x.level)}</span>
      ${x.night_ok ? '<span class="pill night">밤 가능</span>' : ''}
      ${x.also_swim ? '<span class="pill swim">물놀이터</span>' : ''}
      ${esc(x.area ?? '')}${x.__d != null ? ` · 여기서 ${km(x.__d)}` : ''}</p>

    ${x.warns?.length ? `<div class="sec">${warnHtml(x.warns)}</div>` : ''}
    ${x.also_swim ? `<div class="sec"><div class="warn">⚠️ 물놀이 탭에도 있는 곳입니다. 사람이 들어가 있으면 캐스팅하지 마세요.</div></div>` : ''}

    ${x.photos.length ? `<div class="gal">${x.photos.map((u) => `<img loading="lazy" src="${esc(u)}" alt="">`).join('')}</div>` : ''}

    ${sec('오늘 물때', day ? `<div class="tide">
        <div class="best">${runs.map((r) => `${DIR_KO[r.dir]} ${fmt(r.s)}→${fmt(r.e)}`).join(' · ')}</div>
        <div class="now">${moon ? `${esc(moon.label)} · 조차 ${moon.drop}cm` : ''}</div>
      </div>
      <dl class="kv" style="margin-top:10px">
        <dt>만조</dt><dd>${(day.high ?? []).map(([t, cm]) => `${t} (${cm}cm)`).join(' · ')}</dd>
        <dt>간조</dt><dd>${(day.low ?? []).map(([t, cm]) => `${t} (${cm}cm)`).join(' · ')}</dd>
        <dt>유속</dt><dd>${runs.map((r) => `${DIR_KO[r.dir]} ${Math.round(r.speed)}cm/h(${speedGrade(r.speed, station)}) 피크 ${fmt(r.peak)}`).join('<br>')}
          <br><span class="muted">구간 한가운데가 가장 빠르다고 본 근사치입니다</span></dd>
        <dt>기준</dt><dd>${esc(station)}${stKm != null ? ` <span class="muted">(${stKm}km 떨어짐)</span>` : ''}</dd>
      </dl>`
      : `<p class="muted">물때 자료는 ${DB.tide.range.start} ~ ${DB.tide.range.end} 만 넣어뒀어요.</p>`)}

    ${sec('노려볼 어종', bites || '<p class="muted">-</p>')}
    ${sec('위치', `<dl class="kv"><dt>주소</dt><dd>${esc(x.addr ?? '-')}</dd></dl>`)}
    ${sec('바로가기', links ? `<div class="links">${links}</div>` : '<p class="muted">등록된 외부 링크가 없어요.</p>')}
    <p class="muted" style="margin-top:14px">금어기·금지체장·금지구역은 상단 <b>📋 규정</b> 에서 볼 수 있어요.</p>
  `
}

/** 금어기·금지체장·금지구역 — 여행 기간(8/7~14) 기준으로만 추려 둔 것 */
function detailRules() {
  const R = FISH.rules
  if (!R) return '<h2>규정</h2><p class="muted">자료가 없습니다.</p>'
  const sec = (t, h) => (h ? `<div class="sec"><h4>${t}</h4>${h}</div>` : '')
  const flag = (c) => (c === 'verify' ? ' <span class="pill warnpill">확인 필요</span>' : '')

  return `
    <h2>낚시 규정 · 주의</h2>
    <p class="sub">여행 기간 <b>${esc(R.window.start)} ~ ${esc(R.window.end)}</b> 에 걸리는 것만 추렸습니다</p>

    ${sec('이 기간 금어기 — 잡으면 안 됨', `<dl class="kv">${R.closed_season.map((c) => `
      <dt>${esc(c.species)}</dt>
      <dd>${esc(c.period)} · ${esc(c.area)}${flag(c.conf)}
        ${c.penalty ? `<br><span class="muted">${esc(c.penalty)}</span>` : ''}
        ${c.note ? `<br><span class="muted">${esc(c.note)}</span>` : ''}</dd>`).join('')}</dl>`)}

    ${sec('8월엔 풀리는 것', `<dl class="kv">${R.lifted.map((c) => `
      <dt>${esc(c.species)}</dt><dd>${esc(c.period)} <span class="muted">— ${esc(c.note)}</span></dd>`).join('')}</dl>`)}

    ${sec('금지체장 — 이보다 작으면 놓아줄 것', `<dl class="kv">${R.size_limit.map((s) => `
      <dt>${esc(s.species)}</dt>
      <dd>${s.cm ? `${s.cm}cm${s.measure ? ` (${esc(s.measure)})` : ''}` : '규정 없음'}${flag(s.conf)}
        ${s.note ? `<br><span class="muted">${esc(s.note)}</span>` : ''}</dd>`).join('')}</dl>`)}

    ${sec(R.no_fishing.harbor_danger_zone.title, `
      <p>${esc(R.no_fishing.harbor_danger_zone.rule)} — <b>${esc(R.no_fishing.harbor_danger_zone.penalty)}</b></p>
      <p class="muted">${R.no_fishing.harbor_danger_zone.ports.map((p) => `${p.in_scope ? '<b>' : ''}${esc(p.name)}${p.in_scope ? '</b>' : ''}`).join(' · ')}
      <br>굵게 표시한 곳이 우리 동선 안입니다</p>`)}

    ${sec(R.no_fishing.control_zone.title, `
      <p class="muted">${esc(R.no_fishing.control_zone.basis)}</p>
      <dl class="kv">${R.no_fishing.control_zone.zones.map((z) => `
        <dt>${z.in_scope ? '★ ' : ''}${esc(z.name)}</dt><dd>${esc(z.level)} · ${esc(z.sido)}</dd>`).join('')}</dl>
      <p class="muted">${esc(R.no_fishing.control_zone.note)}</p>`)}

    ${sec('주의', R.caution.map((c) => `<div class="bite">
      <div class="bite-h"><b>${esc(c.title)}</b>${c.conf === 'verify' ? ' <span class="pill warnpill">확인 필요</span>' : ''}</div>
      <div>${esc(c.body)}</div>
      ${c.why_us ? `<div class="tipline">${esc(c.why_us)}</div>` : ''}
      ${c.verify_note ? `<div class="muted">${esc(c.verify_note)}</div>` : ''}
    </div>`).join(''))}

    <p class="muted" style="margin-top:14px">법령은 바뀝니다. ‘확인 필요’ 표시가 붙은 항목은 출발 전에 다시 보세요.
      정리 기준일 ${esc(R.at)}.</p>
  `
}

function openDetail(item) {
  const full = item.__d != null ? item : { ...item, __d: state.origin ? dist(state.origin, item) : null }
  $('#detail-body').innerHTML = state.tab === 'water' ? detailWater(full)
    : state.tab === 'fish' ? detailFish(full)
      : detailEat(full)
  $('#detail').hidden = false
  $('#detail').scrollTop = 0
}

/* ══ 조작 ═══════════════════════════════════════════════ */

/** alert 는 화면 전체를 얼려서 모바일에서 쓰기 나쁘다 — 잠깐 뜨는 띠로 대체 */
function toast(msg) {
  let el = $('#toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'toast'
    document.body.appendChild(el)
  }
  el.textContent = msg
  el.classList.add('on')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => el.classList.remove('on'), 3200)
}

function setOrigin(lat, lng, label) {
  state.origin = { lat, lng, label }
  map.setView([lat, lng], Math.max(map.getZoom(), 12))
  syncCond()
  render()
}

/* ── 모드: 지금을 즐기기 / 먼저 알아보기 ─────────────── */

function useNow() {
  state.mode = 'now'
  state.when = new Date()
  $('#mode-now').classList.add('on')
  $('#mode-plan').classList.remove('on')
  // 조건줄은 계속 보인다 — 위치는 언제든 바꿀 수 있어야 하니까
  $('#cond-date').classList.add('locked')
  $('#cond-time').classList.add('locked')
  // 접속 시점의 위치를 기준으로 — 거부하면 위치 없이 목록만
  if (!state.origin || state.origin.auto) locateMe({ quiet: true })
  syncCond()
  render()
}

function usePlan() {
  state.mode = 'plan'
  $('#mode-plan').classList.add('on')
  $('#mode-now').classList.remove('on')
  $('#cond-date').classList.remove('locked')
  $('#cond-time').classList.remove('locked')
  syncCond()
  // 아직 아무것도 안 고른 상태면 바로 고르게 띄운다
  if (!state.planned) openWhen()
}

$('#mode-now').onclick = useNow
$('#mode-plan').onclick = usePlan

function locateMe({ quiet = false } = {}) {
  if (!navigator.geolocation) return quiet || toast('이 브라우저는 위치를 지원하지 않아요.')
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.origin = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: '현재 위치', auto: true }
      map.setView([state.origin.lat, state.origin.lng], Math.max(map.getZoom(), 12))
      syncCond()
      render()
    },
    () => { if (!quiet) toast('위치를 못 가져왔어요. “위치”에서 숙소나 지도를 골라주세요.') },
    { enableHighAccuracy: true, timeout: 8000 },
  )
}

/** 조건 버튼 3개의 표시를 상태에 맞춘다 */
function syncCond() {
  const d = state.when
  const wd = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()]
  $('#cond-date').querySelector('b').textContent = `${d.getMonth() + 1}/${d.getDate()} (${wd})`
  $('#cond-time').querySelector('b').textContent = `${String(d.getHours()).padStart(2, '0')}:00`
  const pl = $('#cond-place')
  pl.querySelector('b').textContent = state.origin?.label ?? '정하기'
  pl.classList.toggle('unset', !state.origin)
}

/* ── 날짜·시간 모달 ──────────────────────────────────── */

const modal = $('#modal')
let calMonth = null // 달력이 보고 있는 달
const draft = { date: null, hour: null } // 확인 누르기 전까지의 선택

const openModal = (step) => {
  modal.hidden = false
  $('#step-when').hidden = step !== 'when'
  $('#step-where').hidden = step !== 'where'
}
const closeModal = () => { modal.hidden = true }
modal.addEventListener('click', (e) => {
  if (e.target === modal || e.target.hasAttribute('data-close')) closeModal()
})

function openWhen() {
  draft.date = new Date(state.when)
  draft.hour = state.when.getHours()
  calMonth = new Date(draft.date.getFullYear(), draft.date.getMonth(), 1)
  drawCal()
  drawHours()
  openModal('when')
}
const goPlan = () => {
  if (state.mode !== 'plan') { usePlan(); return } // usePlan 이 알아서 모달을 연다
  openWhen()
}
$('#cond-date').onclick = goPlan
$('#cond-time').onclick = goPlan

function drawCal() {
  $('#cal-title').textContent = `${calMonth.getFullYear()}년 ${calMonth.getMonth() + 1}월`
  const first = new Date(calMonth.getFullYear(), calMonth.getMonth(), 1)
  const last = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 0)
  const today = ymd(new Date())
  const grid = $('#cal-grid')
  grid.innerHTML = ''

  // 앞쪽 빈칸
  for (let i = 0; i < first.getDay(); i++) grid.appendChild(document.createElement('span'))

  for (let day = 1; day <= last.getDate(); day++) {
    const d = new Date(calMonth.getFullYear(), calMonth.getMonth(), day)
    const key = ymd(d)
    const b = document.createElement('button')
    b.textContent = day
    // 여행 기간은 눈에 띄게 (물때가 있는 날들)
    if (key >= DB.trip.start && key <= DB.trip.end) b.classList.add('trip')
    if (key === today) b.classList.add('today')
    if (key === ymd(draft.date)) b.classList.add('on')
    b.onclick = () => { draft.date = d; drawCal() }
    grid.appendChild(b)
  }
}
$('#cal-prev').onclick = () => { calMonth.setMonth(calMonth.getMonth() - 1); drawCal() }
$('#cal-next').onclick = () => { calMonth.setMonth(calMonth.getMonth() + 1); drawCal() }

function drawHours() {
  const box = $('#hours')
  box.innerHTML = ''
  for (let h = 0; h < 24; h++) {
    const b = document.createElement('button')
    b.textContent = `${String(h).padStart(2, '0')}시`
    if (h === draft.hour) b.classList.add('on')
    b.onclick = () => { draft.hour = h; drawHours() }
    box.appendChild(b)
  }
}

$('#ok-when').onclick = () => {
  state.when = new Date(draft.date.getFullYear(), draft.date.getMonth(), draft.date.getDate(), draft.hour, 0)
  state.planned = true
  syncCond()
  render()
  drawWhere() // 이어서 위치 고르기
  openModal('where')
}
$('#back-when').onclick = () => openModal('when')

/* ── 위치 고르기 ─────────────────────────────────────── */

let whereDraft = null

function lodgingFor(date) {
  return DB.trip.lodging.find((l) => l.date === ymd(date) && l.lat) ?? null
}

function drawWhere() {
  const d = state.when
  const wd = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()]
  $('#where-sub').textContent =
    `${d.getMonth() + 1}/${d.getDate()} (${wd}) ${String(d.getHours()).padStart(2, '0')}시 기준으로 찾아요`

  const stay = lodgingFor(d)
  const others = DB.trip.lodging
    .filter((l) => l.lat && l.name !== stay?.name)
    .filter((l, i, a) => a.findIndex((x) => x.name === l.name) === i)

  const opts = []
  if (stay) opts.push({ k: 'stay', ic: '🏠', t: `${stay.name}`, s: `이 날 묵는 숙소 · ${stay.addr ?? stay.area}`, lat: stay.lat, lng: stay.lng, label: stay.name })
  opts.push({ k: 'gps', ic: '📍', t: '현재 위치', s: '지금 내가 있는 곳', lat: null, lng: null, label: '현재 위치' })
  for (const l of others) {
    opts.push({ k: 'lodge', ic: '🛏', t: l.name, s: `${l.date.slice(5)} 숙소 · ${l.addr ?? l.area}`, lat: l.lat, lng: l.lng, label: l.name })
  }
  // 지금 쓰고 있는 위치가 숙소도 GPS도 아니면(=지도에서 찍은 곳) 목록에 살려둔다
  if (state.origin && !opts.some((o) => o.label === state.origin.label)) {
    opts.push({ k: 'cur', ic: '📌', t: state.origin.label, s: '지금 보고 있는 기준점', lat: state.origin.lat, lng: state.origin.lng, label: state.origin.label })
  }
  opts.push({ k: 'map', ic: '🗺', t: '지도에서 직접 찍기', s: '해변이나 특정 지점을 기준으로', lat: null, lng: null, label: '지정한 위치' })

  // 이미 위치를 잡아둔 상태면 그걸 선택된 채로 연다.
  // (숙소를 기본으로 두되, 지도에서 찍어둔 걸 다시 열었을 때 숙소로 되돌아가면 안 된다)
  whereDraft =
    opts.find((o) => state.origin && o.label === state.origin.label) ??
    opts.find((o) => o.k === (stay ? 'stay' : 'gps'))
  const box = $('#where-list')
  box.innerHTML = ''
  for (const o of opts) {
    const b = document.createElement('button')
    b.className = 'where' + (o === whereDraft ? ' on' : '')
    b.innerHTML = `<span class="ic">${o.ic}</span><span class="tx"><b>${esc(o.t)}</b><small>${esc(o.s)}</small></span>`
    b.onclick = () => {
      whereDraft = o
      ;[...box.children].forEach((c) => c.classList.remove('on'))
      b.classList.add('on')
    }
    box.appendChild(b)
  }
}

$('#ok-where').onclick = () => {
  const o = whereDraft
  closeModal()
  if (!o) return
  if (o.k === 'gps') return locateMe()
  if (o.k === 'map') return startPick()
  setOrigin(o.lat, o.lng, o.label)
}
// 위치는 모드와 무관하게 언제든 바꿀 수 있다.
// (같은 날이라도 오후엔 숙소가 아니라 해변에서 출발할 수 있으니까)
$('#cond-place').onclick = () => { drawWhere(); openModal('where') }

/* ── 지도에서 찍기 ───────────────────────────────────── */

function startPick() {
  state.picking = true
  $('#pickbar').hidden = false
  $('#sheet').className = 'lo'
  setTimeout(() => map.invalidateSize(), 240)
}
function stopPick() {
  state.picking = false
  $('#pickbar').hidden = true
  $('#sheet').className = 'mid'
  setTimeout(() => map.invalidateSize(), 240)
}
$('#pick-cancel').onclick = stopPick
map.on('click', (e) => {
  if (!state.picking) return
  stopPick()
  setOrigin(e.latlng.lat, e.latlng.lng, '지정한 위치')
})

/* ── 나머지 컨트롤 ───────────────────────────────────── */

$('#in-radius').oninput = (e) => {
  state.radius = Number(e.target.value)
  $('#lb-radius').textContent = state.radius.toFixed(1)
  render()
}

$$('#row-filter .f').forEach((b) => {
  b.onclick = () => {
    $$('#row-filter .f').forEach((x) => x.classList.remove('on'))
    b.classList.add('on')
    state.cat = b.dataset.cat
    render()
  }
})
$$('#row-kind .f').forEach((b) => {
  b.onclick = () => {
    $$('#row-kind .f').forEach((x) => x.classList.remove('on'))
    b.classList.add('on')
    state.kind = b.dataset.kind
    render()
  }
})
$$('#row-shop .f').forEach((b) => {
  b.onclick = () => {
    $$('#row-shop .f').forEach((x) => x.classList.remove('on'))
    b.classList.add('on')
    state.shop = b.dataset.shop
    render()
  }
})
$$('#row-craft .f').forEach((b) => {
  b.onclick = () => {
    $$('#row-craft .f').forEach((x) => x.classList.remove('on'))
    b.classList.add('on')
    state.craft = b.dataset.craft
    render()
  }
})
$$('#list-filter .f').forEach((b) => {
  b.onclick = () => {
    $$('#list-filter .f').forEach((x) => x.classList.remove('on'))
    b.classList.add('on')
    state.list = b.dataset.pick
    render()
  }
})
$('#in-search').oninput = (e) => { state.q = e.target.value; render() }

/* ── 낚시 필터 ─────────────────────────────────────────── */

// 어종 칩은 데이터에서 만든다 (fishing-species.json 의 chip:true)
{
  const row = $('#row-fish-species')
  for (const sp of (FISH.species ?? []).filter((s) => s.chip)) {
    const b = document.createElement('button')
    b.className = 'f'
    b.dataset.fish = sp.id
    b.textContent = sp.name
    row.appendChild(b)
  }
}

$('#row-fish-spot').addEventListener('click', (e) => {
  const b = e.target.closest('.f')
  if (!b || !b.dataset.spot) return // 같은 줄에 있는 📋 규정 버튼은 필터가 아니다
  $$('#row-fish-spot .f').forEach((x) => x.classList.remove('on'))
  b.classList.add('on')
  state.spot = b.dataset.spot
  render()
})

$('#row-fish-species').addEventListener('click', (e) => {
  const b = e.target.closest('.f')
  if (!b || !b.dataset.fish) return // 같은 줄에 있는 📋 규정 버튼은 필터가 아니다
  $$('#row-fish-species .f').forEach((x) => x.classList.remove('on'))
  b.classList.add('on')
  state.fish = b.dataset.fish
  render()
})

$('#btn-rules').onclick = () => {
  $('#detail-body').innerHTML = detailRules()
  $('#detail').hidden = false
  $('#detail').scrollTop = 0
}

/* ── 탭 ─────────────────────────────────────────────────── */

const TABS = ['eat', 'shop', 'craft', 'water', 'fish']

$$('.tab').forEach((t) => {
  t.onclick = () => {
    $$('.tab').forEach((x) => x.classList.remove('on'))
    t.classList.add('on')
    state.tab = t.dataset.tab
    const tab = state.tab
    // 강조색 전환 — 맛집 귤색 / 체험 초록 / 물놀이 바다 파랑 / 낚시 딥틸
    for (const k of TABS) document.body.classList.toggle(`t-${k}`, tab === k)

    $('#row-filter').hidden = tab !== 'eat'
    $('#row-shop').hidden = tab !== 'shop'
    $('#row-craft').hidden = tab !== 'craft'
    $('#row-kind').hidden = tab !== 'water'
    $('#row-fish-spot').hidden = tab !== 'fish'
    $('#row-fish-species').hidden = tab !== 'fish'
    // 검색은 지형지물을 찾는 두 탭에서만
    $('#row-search').hidden = tab !== 'water' && tab !== 'fish'
    $('#in-search').placeholder = tab === 'fish'
      ? '방파제·갯바위·낚시점 이름이나 지역 검색'
      : '해수욕장·포구 이름이나 지역 검색'
    $('#list-filter').hidden = tab === 'water' || tab === 'fish' // Pick 개념이 없다
    $('#detail').hidden = true
    render()
  }
})

$('#list').addEventListener('click', (e) => {
  const card = e.target.closest('.card')
  if (!card) return
  const item = currentItems().find((x) => x.id === card.dataset.id)
    ?? tabSource().find((x) => x.id === card.dataset.id)
  if (item) openDetail(item)
})
$('#btn-back').onclick = () => { $('#detail').hidden = true }

/* ── 시트 높이 ──────────────────────────────────────────
 *
 * 손잡이가 끌 수 있게 생겼으면 끌려야 한다.
 * Pointer Events 라 마우스·터치가 같은 코드로 돈다 — 데스크톱에서도 테스트된다.
 * 조금만 움직이면 끈 게 아니라 누른 것으로 보고 예전처럼 3단 토글. */
{
  const sheet = $('#sheet')
  const STEPS = ['lo', 'mid', 'hi']
  // CSS 의 .lo/.mid/.hi 와 같은 값이어야 한다 (96px / 46vh / 100% - tabs - 8px)
  const tabsH = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tabs-h')) || 56
  const heightOf = (step) => ({
    lo: 96,
    mid: window.innerHeight * 0.46,
    hi: window.innerHeight - tabsH() - 8,
  }[step])

  const settle = (px) => {
    // 놓은 높이에서 가장 가까운 단으로 붙인다
    let best = STEPS[0]
    for (const s of STEPS) if (Math.abs(heightOf(s) - px) < Math.abs(heightOf(best) - px)) best = s
    return best
  }

  // 손잡이 막대 하나만 잡게 하면 폰에서 너무 좁다 — 머리글 줄까지 잡힌다
  const handles = [$('#grip'), $('#sheet-head')]
  let drag = null

  const down = (el) => (e) => {
    drag = { y: e.clientY, h: sheet.getBoundingClientRect().height, moved: false, el }
    sheet.classList.add('dragging') // 트랜지션을 끊는다. 안 끊으면 손가락보다 늦게 따라온다
    // 포인터 캡처가 실패해도(합성 이벤트 등) 드래그 자체는 계속돼야 한다
    try { el.setPointerCapture(e.pointerId) } catch { /* 무시 */ }
    e.preventDefault()
  }

  const move = (e) => {
    if (!drag) return
    const dy = drag.y - e.clientY // 위로 끌면 +
    if (Math.abs(dy) > 4) drag.moved = true
    const min = heightOf('lo')
    const max = heightOf('hi')
    sheet.style.height = `${Math.max(min, Math.min(max, drag.h + dy))}px`
  }

  const end = (e) => {
    if (!drag) return
    const px = sheet.getBoundingClientRect().height
    const { moved, el } = drag
    drag = null
    sheet.style.height = ''
    sheet.classList.remove('dragging')
    // 끌었으면 가장 가까운 단으로, 그냥 눌렀으면 예전처럼 3단 토글
    sheet.className = moved
      ? settle(px)
      : (sheet.classList.contains('mid') ? 'hi' : sheet.classList.contains('hi') ? 'lo' : 'mid')
    try {
      if (e?.pointerId != null && el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    } catch { /* 무시 */ }
    setTimeout(() => map.invalidateSize(), 240)
  }

  for (const el of handles) {
    el.addEventListener('pointerdown', down(el))
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
  }
}

/* ══ 시작 ═══════════════════════════════════════════════ */
document.body.classList.add('t-eat')
syncPinScale()
useNow() // 접속하면 "지금을 즐기기" 가 기본
map.fitBounds(L.latLngBounds(DB.places.map((p) => [p.lat, p.lng])), { padding: [30, 30] })
