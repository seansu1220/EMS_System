/**
 * 測試用傷票的繪圖（瀏覽器 canvas）。
 *
 * 版面照紙本「檢傷追蹤」傷票重畫：正面是姓名／性別年齡／補充說明，
 * 背面是時間醫院車輛、人形圖、生命徵象表；兩面下半部都是 0 / I / II / III 四條檢傷色帶，
 * 最底下是沿線撕下的存根。每一面有 QR code、黑色色帶裡有條碼，內容都是傷票號碼。
 *
 * 座標一律用**公釐**、原點在傷票左上角，由 `Pen` 換算成像素——
 * 不直接對 canvas 設縮放，是因為部分瀏覽器會把很小的字級先取整數再縮放，字會變形。
 *
 * 只負責「在給定的 canvas 上畫一張傷票」；排版成 A4、轉 PDF 在 `triageTagPdf.ts`。
 */
import QRCode from 'qrcode';
import JsBarcode from 'jsbarcode';
import {
  TRIAGE_TAG_FONT_FAMILY,
  TRIAGE_TAG_LAYOUT,
  TRIAGE_TAG_LEVELS,
} from '../config/triageTag';

/** 一張傷票要用到的兩種碼（同一個號碼正反面共用，只產生一次）。 */
export interface TriageTagCodeImages {
  qr: HTMLCanvasElement;
  barcode: HTMLCanvasElement;
}

interface TextStyle {
  /** 字級（公釐，約等於字高）。 */
  size: number;
  bold?: boolean;
  color?: string;
  align?: CanvasTextAlign;
}

/** 以公釐作畫的小工具（內部換算成像素）。 */
export interface Pen {
  ctx: CanvasRenderingContext2D;
  /** 公釐 → 像素（含傷票在頁面上的位移）。 */
  x: (mm: number) => number;
  y: (mm: number) => number;
  /** 長度（公釐 → 像素，不含位移）。 */
  len: (mm: number) => number;
}

const TAG_WIDTH = TRIAGE_TAG_LAYOUT.tagWidthMm;
const TAG_HEIGHT = TRIAGE_TAG_LAYOUT.tagHeightMm;

/** 版面上各區塊的位置（公釐）。集中在這裡，調版面只改數字。 */
const GEOMETRY = {
  /** 掛繩孔（正面在左上、背面在右上，雙面印刷時剛好疊在同一個位置）。 */
  holeInset: 9.5,
  holeY: 9,
  holeRadius: 3.5,
  /** 可撕下的斜角：正面右上、背面左上，沿虛線撕。 */
  cornerCutTop: 24,
  cornerCutSide: 55,
  /** 色帶區。 */
  bandsTop: 137,
  bandHeight: 29,
  bandGap: 2,
  /** 最底下的存根條。 */
  stubTop: 261,
  qrSize: 19,
} as const;

const COLORS = {
  ink: '#1f1f1f',
  line: '#8a8a8a',
  hint: '#6b6b6b',
  hintFill: '#e4e4e4',
  stubFill: '#ebebeb',
  cutGuide: '#b5b5b5',
} as const;

/** 建立一支畫筆：傷票左上角在頁面上的位置為 (originXmm, originYmm)。 */
export function createPen(
  ctx: CanvasRenderingContext2D,
  pxPerMm: number,
  originXmm: number,
  originYmm: number,
): Pen {
  return {
    ctx,
    x: (mm) => (originXmm + mm) * pxPerMm,
    y: (mm) => (originYmm + mm) * pxPerMm,
    len: (mm) => mm * pxPerMm,
  };
}

/** 產生 QR code 與條碼的圖（內容都是傷票號碼）。 */
export async function createTriageTagCodeImages(tagNumber: string): Promise<TriageTagCodeImages> {
  try {
    const qr = document.createElement('canvas');
    await QRCode.toCanvas(qr, tagNumber, { margin: 0, width: 240, errorCorrectionLevel: 'M' });
    const barcode = document.createElement('canvas');
    JsBarcode(barcode, tagNumber, {
      format: 'CODE128',
      displayValue: false,
      margin: 0,
      width: 4,
      height: 160,
    });
    return { qr, barcode };
  } catch (error) {
    throw new Error(
      `產生傷票 ${tagNumber} 的 QR code／條碼失敗（triageTagDraw.createTriageTagCodeImages）：${(error as Error).message}`,
    );
  }
}

// ── 基本筆畫 ──

function text(pen: Pen, content: string, xMm: number, baselineMm: number, style: TextStyle): void {
  const { ctx } = pen;
  ctx.fillStyle = style.color ?? COLORS.ink;
  ctx.font = `${style.bold ? 'bold ' : ''}${pen.len(style.size)}px ${TRIAGE_TAG_FONT_FAMILY}`;
  ctx.textAlign = style.align ?? 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(content, pen.x(xMm), pen.y(baselineMm));
}

/** 旋轉的文字（以中心點定位）。angle 為弧度，負值＝逆時針（字由下往上讀）。 */
function rotatedText(
  pen: Pen,
  content: string,
  centerXMm: number,
  centerYMm: number,
  angle: number,
  style: TextStyle,
): void {
  const { ctx } = pen;
  ctx.save();
  ctx.translate(pen.x(centerXMm), pen.y(centerYMm));
  ctx.rotate(angle);
  ctx.fillStyle = style.color ?? COLORS.ink;
  ctx.font = `${style.bold ? 'bold ' : ''}${pen.len(style.size)}px ${TRIAGE_TAG_FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(content, 0, 0);
  ctx.restore();
}

/** 直書（一個字一行往下排）。 */
function verticalText(pen: Pen, content: string, centerXMm: number, topMm: number, size: number): void {
  [...content].forEach((char, index) => {
    text(pen, char, centerXMm, topMm + size * (index + 1) * 1.1, { size, align: 'center', color: COLORS.hint });
  });
}

function line(pen: Pen, points: [number, number][], widthMm: number, color: string, dashMm?: number): void {
  const { ctx } = pen;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = pen.len(widthMm);
  ctx.setLineDash(dashMm ? [pen.len(dashMm), pen.len(dashMm * 0.8)] : []);
  ctx.beginPath();
  points.forEach(([xMm, yMm], index) => {
    if (index === 0) ctx.moveTo(pen.x(xMm), pen.y(yMm));
    else ctx.lineTo(pen.x(xMm), pen.y(yMm));
  });
  ctx.stroke();
  ctx.restore();
}

function fillRect(pen: Pen, xMm: number, yMm: number, wMm: number, hMm: number, color: string): void {
  pen.ctx.fillStyle = color;
  pen.ctx.fillRect(pen.x(xMm), pen.y(yMm), pen.len(wMm), pen.len(hMm));
}

function strokeRect(
  pen: Pen,
  xMm: number,
  yMm: number,
  wMm: number,
  hMm: number,
  color: string,
  widthMm: number,
): void {
  const { ctx } = pen;
  ctx.strokeStyle = color;
  ctx.lineWidth = pen.len(widthMm);
  ctx.setLineDash([]);
  ctx.strokeRect(pen.x(xMm), pen.y(yMm), pen.len(wMm), pen.len(hMm));
}

function drawImage(pen: Pen, image: HTMLCanvasElement, xMm: number, yMm: number, wMm: number, hMm: number): void {
  // 條碼與 QR code 是黑白方塊，放大時不能平滑化，否則邊緣糊掉掃不到。
  pen.ctx.imageSmoothingEnabled = false;
  pen.ctx.drawImage(image, pen.x(xMm), pen.y(yMm), pen.len(wMm), pen.len(hMm));
  pen.ctx.imageSmoothingEnabled = true;
}

function hole(pen: Pen, centerXMm: number): void {
  const { ctx } = pen;
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = pen.len(0.35);
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(pen.x(centerXMm), pen.y(GEOMETRY.holeY), pen.len(GEOMETRY.holeRadius), 0, Math.PI * 2);
  ctx.stroke();
}

/** QR code 加上旁邊直立的號碼（字由下往上讀，同紙本）。 */
function qrWithNumber(pen: Pen, codes: TriageTagCodeImages, tagNumber: string, xMm: number, yMm: number): void {
  const size = GEOMETRY.qrSize;
  drawImage(pen, codes.qr, xMm, yMm, size, size);
  rotatedText(pen, tagNumber, xMm + size + 2.6, yMm + size / 2, -Math.PI / 2, { size: 3.6, bold: true });
}

// ── 共用區塊：色帶與存根 ──

/** 色帶裡的等級記號：0 畫成橢圓，I / II / III 畫成直條（同紙本的樣子）。 */
function levelMark(pen: Pen, label: string, bandTopMm: number): void {
  const markTop = bandTopMm + 8;
  const markHeight = GEOMETRY.bandHeight - 16;
  if (label === '0') {
    const { ctx } = pen;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = pen.len(1.1);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.ellipse(pen.x(11), pen.y(markTop + markHeight / 2), pen.len(3.4), pen.len(markHeight / 2), 0, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  [...label].forEach((_, index) => fillRect(pen, 8 + index * 3.6, markTop, 1.3, markHeight, '#ffffff'));
}

/** 黑色色帶裡的白底條碼框（條碼 + 號碼）。 */
function barcodeBox(pen: Pen, codes: TriageTagCodeImages, tagNumber: string, bandTopMm: number): void {
  const boxLeft = 24;
  const boxWidth = 58;
  fillRect(pen, boxLeft, bandTopMm + 3, boxWidth, GEOMETRY.bandHeight - 6, '#ffffff');
  drawImage(pen, codes.barcode, boxLeft + 5, bandTopMm + 5, boxWidth - 10, 15);
  text(pen, tagNumber, boxLeft + boxWidth / 2, bandTopMm + 24.3, { size: 3.6, align: 'center' });
}

/** 0 / I / II / III 四條色帶，色帶之間留白並畫撕線。 */
function levelBands(pen: Pen, codes: TriageTagCodeImages, tagNumber: string): void {
  TRIAGE_TAG_LEVELS.forEach((level, index) => {
    const bandTop = GEOMETRY.bandsTop + index * (GEOMETRY.bandHeight + GEOMETRY.bandGap);
    fillRect(pen, 0, bandTop, TAG_WIDTH, GEOMETRY.bandHeight, level.color);
    levelMark(pen, level.label, bandTop);
    if (index === 0) barcodeBox(pen, codes, tagNumber, bandTop);
    const tearY = bandTop + GEOMETRY.bandHeight + GEOMETRY.bandGap / 2;
    line(pen, [[0, tearY], [TAG_WIDTH, tearY]], 0.3, COLORS.ink, 1.4);
  });
}

/** 最底下的存根條：左邊直書「檢傷沿線撕下」＋ QR code，右邊由呼叫端補內容。 */
function stubStrip(pen: Pen, codes: TriageTagCodeImages, tagNumber: string): void {
  const stubHeight = TAG_HEIGHT - GEOMETRY.stubTop;
  fillRect(pen, 0, GEOMETRY.stubTop, TAG_WIDTH, stubHeight, COLORS.stubFill);
  verticalText(pen, '檢傷沿線撕下', 4, GEOMETRY.stubTop + 1, 2.6);
  fillRect(pen, 8, GEOMETRY.stubTop, 31, stubHeight, '#ffffff');
  qrWithNumber(pen, codes, tagNumber, 9.5, GEOMETRY.stubTop + (stubHeight - GEOMETRY.qrSize) / 2);
}

/** 性別與年齡（正面中段、正面存根共用）：男 女 不明 ／ 約 ＿ 歲。 */
function sexAndAge(pen: Pen, leftMm: number, rightMm: number, baselineMm: number, stacked: boolean): void {
  const style: TextStyle = { size: stacked ? 3.8 : 4.2, bold: true };
  const sexRight = stacked ? rightMm : leftMm + 39;
  const sexLeft = leftMm + 1;
  text(pen, '男', sexLeft, baselineMm, style);
  text(pen, '女', sexLeft + (sexRight - sexLeft) * 0.32, baselineMm, style);
  text(pen, '不明', sexRight - 1, baselineMm, { ...style, align: 'right' });
  line(pen, [[leftMm, baselineMm + 3.5], [sexRight, baselineMm + 3.5]], 0.3, COLORS.line);

  const ageLeft = stacked ? leftMm : sexRight + 4;
  const ageBaseline = stacked ? baselineMm + 11.5 : baselineMm;
  text(pen, '約', ageLeft + 1, ageBaseline, { size: style.size });
  text(pen, '歲', rightMm - 1, ageBaseline, { size: style.size, align: 'right' });
  line(pen, [[ageLeft, ageBaseline + 3.5], [rightMm, ageBaseline + 3.5]], 0.3, COLORS.line);
}

// ── 正面 ──

function frontHeader(pen: Pen, codes: TriageTagCodeImages, tagNumber: string): void {
  hole(pen, GEOMETRY.holeInset);
  text(pen, '檢傷追蹤', 12, 24, { size: 5.5, bold: true });
  line(pen, [[GEOMETRY.cornerCutTop, 0], [TAG_WIDTH, GEOMETRY.cornerCutSide]], 0.3, COLORS.ink, 1.2);
  qrWithNumber(pen, codes, tagNumber, 61, 5);
  text(pen, '後送存根', 88, 31, { size: 3.6, align: 'right' });
}

function frontIdentity(pen: Pen): void {
  text(pen, '姓名', 7, 50, { size: 4 });
  text(pen, '不詳', 87, 62, { size: 4.2, bold: true, align: 'right' });
  line(pen, [[7, 66], [88, 66]], 0.3, COLORS.line);
  sexAndAge(pen, 7, 88, 80, false);
  strokeRect(pen, 5, 90, 85, 42, '#555555', 0.35);
  text(pen, '補充說明', 7, 96, { size: 3.8 });
}

/** 畫一張傷票的正面。 */
export function drawTriageTagFront(pen: Pen, codes: TriageTagCodeImages, tagNumber: string): void {
  fillRect(pen, 0, 0, TAG_WIDTH, TAG_HEIGHT, '#ffffff');
  frontHeader(pen, codes, tagNumber);
  frontIdentity(pen);
  levelBands(pen, codes, tagNumber);
  stubStrip(pen, codes, tagNumber);
  sexAndAge(pen, 44, 91, GEOMETRY.stubTop + 8, true);
  cutGuide(pen);
}

// ── 背面 ──

/** 左上角的後送欄位：時間、醫院、車輛（灰底提示字），與四個分級小方格。 */
function backTransportFields(pen: Pen, tagNumber: string): void {
  rotatedText(pen, tagNumber, 5, 17, Math.PI / 2, { size: 3.6, bold: true });
  const fields: { label: string; hint: string; boxRight: number }[] = [
    { label: '時間', hint: '年 / 月 / 日　時 : 分', boxRight: 44 },
    { label: '醫院', hint: '醫院名稱', boxRight: 40 },
    { label: '車輛', hint: '呼號/車號', boxRight: 36 },
  ];
  fields.forEach((field, index) => {
    const baseline = 9 + index * 7;
    text(pen, field.label, 9.5, baseline, { size: 3.6 });
    fillRect(pen, 18.5, baseline - 3.6, field.boxRight - 18.5, 4.6, COLORS.hintFill);
    text(pen, field.hint, 19.5, baseline - 0.2, { size: 2.3, color: COLORS.hint });
  });
  const squareColors = [
    TRIAGE_TAG_LEVELS[1].color,
    TRIAGE_TAG_LEVELS[0].color,
    TRIAGE_TAG_LEVELS[2].color,
    TRIAGE_TAG_LEVELS[3].color,
  ];
  squareColors.forEach((color, index) => {
    strokeRect(pen, 10.5 + (index % 2) * 6, 27 + Math.floor(index / 2) * 6, 4.5, 4.5, color, 0.5);
  });
  line(pen, [[0, GEOMETRY.cornerCutSide], [TAG_WIDTH - GEOMETRY.cornerCutTop, 0]], 0.3, COLORS.ink, 1.2);
}

function backHeader(pen: Pen, codes: TriageTagCodeImages, tagNumber: string): void {
  hole(pen, TAG_WIDTH - GEOMETRY.holeInset);
  text(pen, '檢傷追蹤', 88, 24, { size: 5.5, bold: true, align: 'right' });
  qrWithNumber(pen, codes, tagNumber, 58, 27);
}

/**
 * 人體輪廓的右半邊（x 從身體中線算起、y 從頭頂算起，單位＝身高的 1%），
 * 左半邊鏡射。頭另外畫橢圓。
 */
const BODY_HALF_OUTLINE: readonly [number, number][] = [
  [0, 56], [3, 68], [3.8, 82], [3.4, 93], [3.2, 99], [8.8, 99], [7.6, 94], [8.5, 82],
  [10.2, 68], [10.8, 54], [9.8, 46], [10.2, 38], [11.5, 27], [12.2, 38], [13.2, 50],
  [14.5, 62], [16, 65], [18, 63], [17, 58], [16, 48], [15, 35], [14, 22], [11, 19],
  [3.5, 17], [3, 14],
];

/** 畫一個人形（front＝正面、否則背面多畫脊椎與肩胛）。 */
function bodyOutline(pen: Pen, centerXMm: number, topMm: number, heightMm: number, isBack: boolean): void {
  const { ctx } = pen;
  const unit = heightMm / 100;
  const px = (dx: number) => pen.x(centerXMm + dx * unit);
  const py = (dy: number) => pen.y(topMm + dy * unit);
  ctx.save();
  ctx.strokeStyle = '#444444';
  ctx.lineWidth = pen.len(0.3);
  ctx.setLineDash([]);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.ellipse(px(0), py(7), pen.len(5.5 * unit), pen.len(7 * unit), 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  BODY_HALF_OUTLINE.forEach(([dx, dy], index) => (index === 0 ? ctx.moveTo(px(dx), py(dy)) : ctx.lineTo(px(dx), py(dy))));
  [...BODY_HALF_OUTLINE].reverse().forEach(([dx, dy]) => ctx.lineTo(px(-dx), py(dy)));
  ctx.closePath();
  ctx.stroke();
  const details: [number, number][][] = isBack
    ? [[[0, 18], [0, 50]], [[3, 24], [7, 23], [8, 30], [4, 31]], [[-3, 24], [-7, 23], [-8, 30], [-4, 31]]]
    : [[[-3, 27], [0, 29], [3, 27]]];
  details.forEach((stroke) => {
    ctx.beginPath();
    stroke.forEach(([dx, dy], index) => (index === 0 ? ctx.moveTo(px(dx), py(dy)) : ctx.lineTo(px(dx), py(dy))));
    ctx.stroke();
  });
  ctx.restore();
}

/** 生命徵象表：時間／呼吸／脈搏／血壓，三列空白。 */
function vitalsTable(pen: Pen): void {
  const left = 5;
  const top = 93;
  const width = 85;
  const headerHeight = 10;
  const rowHeight = 10;
  const rows = 3;
  const headers = ['時間', '呼吸', '脈搏', '血壓'];
  const columnWidth = width / headers.length;
  const bottom = top + headerHeight + rowHeight * rows;
  strokeRect(pen, left, top, width, bottom - top, '#555555', 0.35);
  for (let row = 0; row <= rows; row += 1) {
    const y = top + headerHeight + row * rowHeight;
    line(pen, [[left, y], [left + width, y]], 0.3, '#555555');
  }
  headers.forEach((header, index) => {
    if (index > 0) line(pen, [[left + index * columnWidth, top], [left + index * columnWidth, bottom]], 0.3, '#555555');
    text(pen, header, left + (index + 0.5) * columnWidth, top + 6.6, { size: 3.8, align: 'center' });
  });
}

/** 畫一張傷票的背面。 */
export function drawTriageTagBack(pen: Pen, codes: TriageTagCodeImages, tagNumber: string): void {
  fillRect(pen, 0, 0, TAG_WIDTH, TAG_HEIGHT, '#ffffff');
  backTransportFields(pen, tagNumber);
  backHeader(pen, codes, tagNumber);
  bodyOutline(pen, 33, 50, 40, false);
  bodyOutline(pen, 60, 50, 40, true);
  vitalsTable(pen);
  levelBands(pen, codes, tagNumber);
  stubStrip(pen, codes, tagNumber);
  text(pen, '檢傷存根', 66, GEOMETRY.stubTop + 13.5, { size: 4, align: 'center' });
  cutGuide(pen);
}

/** 傷票外框的裁切線（淺灰虛線，沿線剪下）。 */
function cutGuide(pen: Pen): void {
  const { ctx } = pen;
  ctx.save();
  ctx.strokeStyle = COLORS.cutGuide;
  ctx.lineWidth = pen.len(0.2);
  ctx.setLineDash([pen.len(1.5), pen.len(1)]);
  ctx.strokeRect(pen.x(0), pen.y(0), pen.len(TAG_WIDTH), pen.len(TAG_HEIGHT));
  ctx.restore();
}
