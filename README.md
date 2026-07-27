# 제주 2026.08 — 배포용

**이 저장소는 직접 고치지 마세요.** 빌드 산출물만 담긴 곳입니다.

원본은 비공개 저장소 `mikakims/jeju-2026-08` 이고, 거기서
`node scripts/build-app.mjs` 로 `app/` 을 만든 뒤 그 내용을 여기로 밀어 넣습니다.
여기서 고치면 다음 배포 때 덮어씌워집니다.

## 갱신

원본 저장소에서:

```bash
node scripts/build-app.mjs
node scripts/deploy.mjs
```

## 이 사이트에 대해

로그인도 서버도 없는 정적 모바일 웹입니다. 지도는 Leaflet + CARTO 타일,
장소·사진 데이터는 `data.js` 한 파일에 들어 있습니다.

`robots.txt` 와 `<meta name="robots" content="noindex">` 로 검색엔진 색인을 막아 뒀습니다 —
링크를 아는 사람만 보라고 만든 페이지입니다.
