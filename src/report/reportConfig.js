// Report parameters shared by all data sources.

// The report's 15 departments (whitelist): sales, unfulfilled demand and plan are taken only for these.
export const DEPTS_WL = [
  'E-comm-Маркетплейсы',
  'E-comm-Проф',
  'E-comm-Ритейл',
  'Аптечная косметика-Ритейл',
  'Отдел прямых продаж-Проф',
  'Региональные продажи-Проф',
  'Региональные продажи-Ритейл',
  'Сетевые продажи-Ритейл',
  'Сети-Проф',
  'СТМ, Дискаунтеры',
  'Архив СТМ',
  'Архив Профкосметика-Продажи',
  'Фарма',
  'Экспортные продажи-Проф',
  'Экспортные продажи-Ритейл',
];
// Report history starts in this year (for a like-for-like prior-year comparison).
export const FIRST_YEAR = 2024;
// Year of the operational plan and the analytical forecast.
export const PLAN_YEAR = Number(process.env.REPORT_PLAN_YEAR) || 2026;
export const FC_YEAR = Number(process.env.REPORT_FORECAST_YEAR) || PLAN_YEAR;
// Budget item of the operational plan (by client, regional manager, trademark).
export const PLAN_ARTICLE = process.env.REPORT_PLAN_ARTICLE || `План продаж по клиентам, РМ, ТМ ${PLAN_YEAR}`;
