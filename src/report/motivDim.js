// Sales-incentive group dictionary — a two-level hierarchy of product groups used for sales motivation.
//
// sk — surrogate key (referenced by products), name — lower level, upper — parent (upper level).
// Rows with upper 'Неизвестно' are the upper-level groups themselves. Technical values
// ('Неизвестно', 'Служебная', '<прочие …>') are not treated as groups (snapshotCore.cleanGroup).
// All values are fictional: brands of the demo manufacturer NORD.
//
// Upper level is the incentive segment: Захват (growth brands), Удержание (core), Регулярный
// ассортимент (regular range), Разведка (new brands), ATELIER PROF (professional channel), СТМ
// (private label), archive groups.
export const MOTIV_DIM = [
  { sk: -2, name: '<прочие Аналитика для мотивации>', upper: 'Неизвестно' },
  { sk: -1, name: 'Неизвестно', upper: 'Неизвестно' },
  // ── upper level ──
  { sk: 1, name: 'Захват', upper: 'Неизвестно' },
  { sk: 2, name: 'Удержание', upper: 'Неизвестно' },
  { sk: 3, name: 'Регулярный ассортимент', upper: 'Неизвестно' },
  { sk: 4, name: 'Разведка', upper: 'Неизвестно' },
  { sk: 5, name: 'ATELIER PROF', upper: 'Неизвестно' },
  { sk: 6, name: 'СТМ+Дискаунтеры-Ритейл', upper: 'Неизвестно' },
  { sk: 7, name: 'Архив Новинки Ритейл', upper: 'Неизвестно' },
  { sk: 8, name: 'Архив Ассортимент Ритейл', upper: 'Неизвестно' },
  { sk: 9, name: 'Архив Новинки Проф', upper: 'Неизвестно' },
  { sk: 10, name: 'Прочее', upper: 'Неизвестно' },
  { sk: 11, name: 'Служебная', upper: 'Неизвестно' },
  // ── Захват (growth) ──
  { sk: 101, name: 'CERALUX (Мотивация)', upper: 'Захват' },
  { sk: 102, name: 'LACTOVIA (Мотивация)', upper: 'Захват' },
  { sk: 103, name: 'DERMALINA (Мотивация)', upper: 'Захват' },
  // ── Удержание (core) ──
  { sk: 111, name: 'ГАММА (Мотивация)', upper: 'Удержание' },
  { sk: 112, name: 'КОРОЛЕВНА (Мотивация)', upper: 'Удержание' },
  { sk: 113, name: 'COLORIA (Мотивация)', upper: 'Удержание' },
  // ── Регулярный ассортимент (regular range) ──
  { sk: 121, name: 'SILK (Мотивация)', upper: 'Регулярный ассортимент' },
  { sk: 122, name: 'VECTOR (Мотивация)', upper: 'Регулярный ассортимент' },
  { sk: 123, name: 'VECTOR ANTI-YELLOW (Мотивация)', upper: 'Регулярный ассортимент' },
  { sk: 124, name: 'VECTOR FUSION (Мотивация)', upper: 'Регулярный ассортимент' },
  { sk: 125, name: 'WILD GIRL (Мотивация)', upper: 'Регулярный ассортимент' },
  { sk: 126, name: 'AQUABERRY (Мотивация)', upper: 'Регулярный ассортимент' },
  { sk: 127, name: 'SEDUCTEUR (Мотивация)', upper: 'Регулярный ассортимент' },
  { sk: 128, name: 'ГОРКИ (Мотивация)', upper: 'Регулярный ассортимент' },
  { sk: 129, name: 'ПТИЧКА (Мотивация)', upper: 'Регулярный ассортимент' },
  { sk: 130, name: 'МЕГАДРАКОНЫ (Мотивация)', upper: 'Регулярный ассортимент' },
  // ── Разведка (new brands) ──
  { sk: 141, name: 'MARVELOUS (Мотивация)', upper: 'Разведка' },
  { sk: 142, name: 'FRUIT DRAGONS (Мотивация)', upper: 'Разведка' },
  { sk: 143, name: 'DEO MOTION (Мотивация)', upper: 'Разведка' },
  // present in the strategic plan but has no products yet (launch planned) — an incentive plan without SKUs
  { sk: 144, name: 'ПТИЧКА Новинки (Мотивация)', upper: 'Разведка' },
  // ── professional channel ──
  { sk: 151, name: 'Краситель (Мотивация)', upper: 'ATELIER PROF' },
  { sk: 152, name: 'Ассортимент (Мотивация)', upper: 'ATELIER PROF' },
  { sk: 153, name: 'Блонд (Мотивация)', upper: 'ATELIER PROF' },
  { sk: 154, name: 'VECTOR PROWAY (Мотивация)', upper: 'ATELIER PROF' },
  // ── СТМ (private label) ──
  { sk: 161, name: 'СТМ (Мотивация)', upper: 'СТМ+Дискаунтеры-Ритейл' },
  // ── archive ──
  { sk: 171, name: 'Новинки 2023', upper: 'Архив Новинки Ритейл' },
  { sk: 172, name: 'Ассортимент 2023', upper: 'Архив Ассортимент Ритейл' },
  { sk: 173, name: 'Новинки Проф 2023', upper: 'Архив Новинки Проф' },
  // ── other and technical ──
  { sk: 181, name: 'Ассортимент', upper: 'Прочее' },
  { sk: 182, name: 'Подарочные наборы', upper: 'Прочее' },
  { sk: 191, name: 'Промопродукция', upper: 'Служебная' },
  { sk: 192, name: 'Пробники', upper: 'Служебная' },
];
