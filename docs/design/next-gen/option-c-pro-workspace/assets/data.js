/* 목업 데이터 — 화면 시연용. 실제 값 아님 */
const fmt = (n, d = 0) => Number(n).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
const won = (n) => `${fmt(Math.round(n))}원`;
const usd = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sgn = (n) => (n > 0 ? "+" : n < 0 ? "−" : "");
const pct = (n) => `${sgn(n)}${Math.abs(n).toFixed(2)}%`;
const cls = (n) => (n > 0 ? "up" : n < 0 ? "dn" : "mut");
/** 1,234,5678원 → 1.23억 / 861.6만 */
const short = (n) => { const a = Math.abs(n); const s = n < 0 ? "−" : ""; return a >= 1e8 ? `${s}${(a / 1e8).toFixed(2)}억` : a >= 1e4 ? `${s}${(a / 1e4).toFixed(a >= 1e6 ? 0 : 1).replace(/\.0$/, "")}만` : `${s}${fmt(a)}`; };
const FX = 1393.6;

const PF = {
  netWorth: 115168420, daily: { diff: 1284300, pct: 1.13 }, monthly: { diff: 3912000, pct: 3.52 }, profit: 12083000,
  history: [96.1, 96.8, 97.4, 96.9, 98.2, 99.0, 98.4, 99.6, 101.2, 100.8, 102.3, 101.9, 103.4, 104.1, 103.2, 105.0, 106.3, 105.7, 107.2, 108.4, 107.9, 109.8, 110.6, 109.9, 111.3, 112.4, 111.8, 113.1, 113.9, 115.17],
  alloc: [["국내주식", 17512000, "var(--d1)"], ["해외주식", 20154000, "var(--d2)"], ["코인", 22744000, "var(--d3)"], ["현금성", 22608000, "var(--d4)"], ["기타", 32150000, "var(--d5)"]],
  sources: [
    { id: "kis", label: "한국투자", val: 19992000, parts: "17,512,000원 · 예수금 2,480,000원", status: null },
    { id: "toss", label: "토스", val: 21882000, parts: "$15,702.00", status: null },
    { id: "binance", label: "Binance", val: 22744000, parts: "16,320.15 USDT · Earn 잔고를 읽지 못했습니다", status: ["일부 누락", "warn"] },
    { id: "manual", label: "직접 입력", val: 50550000, parts: "50,550,000원", status: null },
  ],
  holdings: [
    { k: "domesticStock", src: "kis", name: "삼성전자", sym: "005930", qty: "120주", avg: "68,400", price: "71,800", val: 8616000, sub: "", pnl: 408000, pp: 4.97 },
    { k: "domesticStock", src: "kis", name: "SK하이닉스", sym: "000660", qty: "25주", avg: "188,000", price: "214,500", val: 5362500, sub: "", pnl: 662500, pp: 14.1 },
    { k: "domesticStock", src: "kis", name: "NAVER", sym: "035420", qty: "18주", avg: "212,000", price: "196,300", val: 3533400, sub: "", pnl: -282600, pp: -7.41 },
    { k: "overseasStock", src: "toss", name: "NVIDIA", sym: "NVDA", qty: "40주", avg: "$118.20", price: "$182.44", val: 10169000, sub: "$7,297.60", pnl: 3580000, pp: 54.35, pnlS: "+$2,569.60" },
    { k: "overseasStock", src: "toss", name: "Apple", sym: "AAPL", qty: "22주", avg: "$201.50", price: "$228.10", val: 6993000, sub: "$5,018.20", pnl: 815000, pp: 13.2, pnlS: "+$585.20" },
    { k: "overseasStock", src: "toss", name: "Tesla", sym: "TSLA", qty: "8주", avg: "$312.00", price: "$268.40", val: 2992000, sub: "$2,147.20", pnl: -486000, pp: -13.97, pnlS: "−$348.80" },
    { k: "crypto", src: "binance", name: "비트코인", sym: "BTC", qty: "0.0842 BTC", avg: "", price: "104,210", val: 12229000, sub: "8,774.48 USDT", pnl: null, pp: null },
    { k: "crypto", src: "binance", name: "이더리움", sym: "ETH", qty: "1.35 ETH", avg: "", price: "3,912.4", val: 7360000, sub: "5,281.74 USDT", pnl: null, pp: null },
    { k: "crypto", src: "binance", name: "솔라나", sym: "SOL", qty: "12.4 SOL", avg: "", price: "182.6", val: 3155000, sub: "2,264.24 USDT", pnl: null, pp: null },
    { k: "manual", src: "manual", name: "퇴직연금 IRP", sym: "", qty: "연금", avg: "", price: null, val: 32150000, sub: "", pnl: null, pp: null, manual: true },
    { k: "manual", src: "manual", name: "주택청약", sym: "", qty: "예금", avg: "", price: null, val: 18400000, sub: "", pnl: null, pp: null, manual: true },
  ],
  dust: 3,
  orders: [
    { side: "BUY", sym: "SK하이닉스", qty: 5, price: "205,000", st: "접수" },
    { side: "SELL", sym: "TSLA", qty: 4, price: "285.00", st: "미체결" },
  ],
};

const JR = [
  { d: "2026-11-06", side: "BUY", name: "SK하이닉스", sym: "000660", trade: "5주 · 205,000원", broker: "한국투자", src: "챗 주문", st: "pending", thesis: "HBM4 공급 확정 뉴스 후 눌림. 20일선 지지 확인하고 1차 분할 매수", tags: ["눌림목", "실적"], amt: "1,025,000원", emo: "차분" },
  { d: "2026-11-05", side: "SELL", name: "Tesla", sym: "TSLA", trade: "4주 · $281.20", broker: "토스", src: null, thesis: null, tags: [], amt: "$1,124.80", emo: null },
  { d: "2026-11-05", side: "BUY", name: "비트코인", sym: "BTCUSDT", trade: "0.012 BTC · 103,880", broker: "Binance", src: "자동 매매", thesis: "감시 w_7f2 — 4시간봉 종가 103,500 돌파 시 매수", tags: ["돌파"], amt: "1,246.56 USDT", emo: null },
  { d: "2026-11-03", side: "SELL", name: "이더리움", sym: "ETHUSDT", trade: "0.4 ETH · 4,010.2", broker: "Binance", src: null, thesis: "목표가 4,000 도달 — 절반 익절", tags: ["익절"], amt: "1,604.08 USDT", pnl: "+212.40 USDT", emo: "확신" },
  { d: "2026-11-03", side: "BUY", name: "삼성전자", sym: "005930", trade: "30주 · 70,200원", broker: "한국투자", src: "직접", thesis: "배당 기준일 전 비중 확대", tags: ["배당"], amt: "2,106,000원", emo: "조급" },
  { d: "2026-10-31", side: "BUY", name: "NAVER", sym: "035420", trade: "6주 · 199,500원", broker: "한국투자", src: null, st: "canceled", thesis: null, tags: [], amt: null, emo: null },
];

const TX = [
  { d: "2026-11-06", m: "스타벅스 역삼점", c: "카페", who: "ms", memo: "", amt: -6100, src: "agent" },
  { d: "2026-11-06", m: "쿠팡", c: "생활", who: "지수", memo: "세제·키친타월", amt: -32480 },
  { d: "2026-11-05", m: "김밥천국", c: "식비", who: "ms", memo: "", amt: -8000, src: "agent" },
  { d: "2026-11-05", m: "카카오T", c: "교통", who: "ms", memo: "야근 택시", amt: -18700 },
  { d: "2026-11-05", m: "이마트 성수", c: "식비", who: "지수", memo: "주말 장보기", amt: -96320 },
  { d: "2026-11-04", m: "11월 급여", c: null, who: "ms", memo: "", amt: 4820000 },
  { d: "2026-11-04", m: "넷플릭스", c: "구독", who: "ms", memo: "", amt: -17000 },
  { d: "2026-11-03", m: "올리브영", c: "생활", who: "지수", memo: "", amt: -41200 },
];
const CAT = { 식비: "var(--d1)", 생활: "var(--d2)", 카페: "var(--d3)", 교통: "var(--d4)", 구독: "var(--d6)", 주거: "var(--d7)", 기타: "var(--d5)" };
