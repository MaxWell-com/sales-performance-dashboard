// Отдача страниц: отчет, заглушка на время сборки, ошибка, «нет доступа», справка.
//
// Отчет — один самодостаточный HTML-файл: верстка, логика вкладок, фильтры, графики и выгрузка
// в xlsx лежат в src/report/dashboard.template.html и ничего не тянут извне (ни CDN, ни шрифтов):
// отчет работает и в закрытой сети. Шрифты оформления (Inter, Geist) вшиты в страницу как base64
// из src/report/fonts.css. Сервер подставляет в шаблон снимок данных на место метки __DASH_DATA__.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.join(__dirname, 'report');
const DEV = process.env.NODE_ENV === 'development';

// В проде файлы читаются один раз (меняются только с деплоем), в разработке — на каждый запрос:
// правки верстки подхватываются без перезапуска, а собранный снимок остается в памяти.
const cache = new Map();
function read(name) {
  if (!DEV && cache.has(name)) return cache.get(name);
  const text = fs.readFileSync(path.join(REPORT_DIR, name), 'utf-8');
  cache.set(name, text);
  return text;
}

export function esc(value) {
  return String(value ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
}

/**
 * Отчет: снимок подставляется в шаблон как JSON.
 * `<` экранируем в < — иначе имя номенклатуры с угловой скобкой закрыло бы <script>.
 * Замена через функцию: строка-замена трактовала бы `$&` внутри данных как подстановку.
 */
export function renderReport(snapshot) {
  const data = snapshot.json.replace(/</g, '\\u003c');
  const body = read('dashboard.template.html').replace('__DASH_DATA__', () => data);
  return (
    `<!doctype html><html lang="ru"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Общий информационный отчет продаж</title>` +
    `<style>${read('fonts.css')}</style></head><body>\n${body}\n</body></html>`
  );
}

/** Руководство пользователя — статичная страница. */
export function renderGuide() {
  return read('guide.html');
}

/**
 * Служебные экраны (сборка, ошибка, нет доступа) — на тех же токенах, что отчет:
 * пользователь не должен думать, что попал в другое приложение.
 */
function page(title, body, { refreshSec } = {}) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refreshSec ? `<meta http-equiv="refresh" content="${refreshSec}">` : ''}
<title>${esc(title)}</title>
<style>
${read('fonts.css')}
  :root { color-scheme: light;
    --bg:#F6F3EF; --surface:#FFFFFF; --surface-2:#F8F5F1; --border:#E7E1D9; --border-strong:#CFC7BC;
    --text:#191614; --text-muted:#635C55; --text-subtle:#7A736B; --accent:#FF5C00; --neg:#BC2417;
    --font-h:"Inter",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
    --font-b:"Geist",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.6 var(--font-b);
         display:flex; align-items:center; justify-content:center; min-height:100vh; padding:24px; }
  .box { position:relative; overflow:hidden; max-width:620px; width:100%; padding:26px 28px;
         background:var(--surface); border:1px solid var(--border); border-radius:8px;
         box-shadow:0 1px 3px #14100C14; }
  .deco { position:absolute; inset:0; overflow:hidden; pointer-events:none; }
  .deco svg { position:absolute; top:-150px; right:-90px; width:520px; height:300px; opacity:.5; }
  .box > *:not(.deco) { position:relative; }
  h1 { margin:0 0 10px; font-family:var(--font-h); font-size:20px; font-weight:600; letter-spacing:-.3px; }
  p { margin:0 0 8px; color:var(--text-muted); font-size:13px; }
  .muted { font-size:12px; color:var(--text-subtle); }
  .steps { margin:14px 0 0; padding:0; list-style:none; display:flex; flex-direction:column; gap:6px; }
  .steps li { display:flex; gap:9px; align-items:flex-start; font-size:13px; color:var(--text-muted); }
  .steps li::before { content:""; flex:none; width:3px; align-self:stretch; border-radius:2px;
                      background:var(--border-strong); }
  pre { white-space:pre-wrap; margin:14px 0 0; padding:11px 13px; background:var(--surface-2);
        border:1px solid var(--border); border-radius:6px; font:12px/1.5 Consolas,Menlo,monospace;
        color:var(--neg); }
</style></head><body><div class="box">
<div class="deco"><svg viewBox="0 0 520 300" preserveAspectRatio="xMaxYMin slice" aria-hidden="true">
<defs><linearGradient id="d0" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#FF5C00"/><stop offset="1" stop-color="#FFB380"/></linearGradient>
<linearGradient id="d1" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#FFB380"/><stop offset="1" stop-color="#FFE7D4"/></linearGradient></defs>
<circle cx="400" cy="40" r="190" fill="none" stroke="url(#d0)" stroke-width="26" stroke-dasharray="697 497" opacity=".7" transform="rotate(-26 400 40)"/>
<circle cx="415" cy="48" r="255" fill="none" stroke="url(#d1)" stroke-width="20" stroke-dasharray="667 935" opacity=".5" transform="rotate(-42 415 48)"/>
</svg></div>
${body}</div></body></html>`;
}

/**
 * Заглушка на время первой сборки. Держать запрос открытым до конца сборки нельзя: прокси перед
 * приложением может закрыть его по таймауту. Поэтому страница легкая и сама перезагружается,
 * пока снимок не готов. Прогресс-бара нет: реального прогресса сборки мы не знаем.
 */
export function renderBuilding({ startedAt, elapsedSec }) {
  const started = startedAt ? new Date(startedAt).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow' }) : null;
  return page(
    'Отчет собирается',
    `
    <h1>Отчет собирается</h1>
    <p>Идет сборка снимка данных. Страница обновится сама, закрывать ее не нужно.</p>
    <ul class="steps">
      <li>Продажи, дефектура, остатки, производство и операционный план.</li>
      <li>Стратегический план, прогноз продаж, торговые марки и базовые цены.</li>
    </ul>
    <p class="muted" style="margin-top:14px">${started ? `Сборка начата в ${esc(started)}` : 'Сборка запускается'}${
      elapsedSec ? `, прошло ${Math.round(elapsedSec)} с` : ''
    }. Страница обновляется каждые 10 секунд.</p>
  `,
    { refreshSec: 10 },
  );
}

/** Ошибка сборки: показываем причину, а не пустой экран — чаще всего это недоступный источник. */
export function renderError(message) {
  return page(
    'Отчет недоступен',
    `
    <h1>Не удалось собрать отчет</h1>
    <p>Чаще всего это значит, что источник данных недоступен или не заданы параметры подключения
       к нему. Страница попробует обновиться сама через минуту.</p>
    <ul class="steps">
      <li>Проверьте DATA_SOURCE и переменные подключения (см. .env.example).</li>
      <li>Для запуска без инфраструктуры используйте DATA_SOURCE=demo.</li>
    </ul>
    <pre>${esc(message)}</pre>
  `,
    { refreshSec: 60 },
  );
}

/** 403: вход пройден, но пользователь не в нужной группе — отдельный экран, а не голый JSON. */
export function renderForbidden(teams, email) {
  return page(
    'Нет доступа',
    `
    <h1>Нет доступа к отчету</h1>
    <p>Вы вошли${email ? ` как <b>${esc(email)}</b>` : ''}, но отчет открыт только участникам
       групп <b>${esc(teams)}</b>.</p>
    <ul class="steps">
      <li>Запросите доступ у администратора, указав название отчета.</li>
      <li>Если доступ выдали только что — выйдите и войдите снова, чтобы обновить группы.</li>
    </ul>
  `,
  );
}
