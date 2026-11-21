import { esc, getDealer360, getDealerSellThrough } from './erp-data-layer.js';
const MON = ['يناير','فبراير','مارس','إبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
const n = (v) => Math.round(v || 0).toLocaleString('en-US');
const g = (c, p) => (p > 0 ? Math.round(((c - p) / p) * 1000) / 10 : null);
const badge = (v) => (v === null ? '<span class="muted">جديد/—</span>' : `<b style="color:var(${v >= 0 ? '--ok,#1F7A4D' : '--danger'})">${v >= 0 ? '▲' : '▼'} ${Math.abs(v)}%</b>`);
const kpi = (l, v, s = '') => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div>${s ? `<div class="label">${s}</div>` : ''}</div>`;
export function renderDealer360(el, customerId, year, { vat = 14, cmpYear = null } = {}) {
  if (!customerId) { el.innerHTML = '<p class="muted">اختار تاجر.</p>'; return; }
  const d = getDealer360(customerId, year, { vatRate: vat, cmpYear }), basis = vat ? `صافي بدون ضريبة (÷${1 + vat / 100})` : 'شامل الضريبة', w = d.whiteSpace, t = d.target, s = d.supply;
  const tbl = (head, rows) => `<div style="overflow-x:auto"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  el.innerHTML = `
  <p class="muted">القيم ${basis} بعد خصم التاجر، المسلَّم بتاريخ التسليم. لاحظ: الـ Slabs فوق شاملة الضريبة.</p>
  <div class="kpis">
    ${kpi(`مبيعات ${year}`, n(d.total), `${badge(g(d.ytdCur, d.ytdPrev))} عن نفس الفترة ${d.cmpYear}`)}
    ${kpi('آخر شراء', d.lastDate || '—', d.daysSince === null ? '' : `من ${d.daysSince} يوم`)}
    ${kpi('عدد الفواتير', d.orders, `متوسط الفاتورة ${n(d.avgOrder)}`)}
    ${kpi('White Space', `${w.bought.length}/${w.total}`, w.need ? `ناقصه ${w.need} فاميلي للـ KPI` : '✅ حقق الـ KPI')}
    ${kpi('التارجت', t.has ? (t.focus ? esc(t.focus.name) : 'كله اتحقق') : '—', t.has && t.focus ? (t.focus.reached ? '✅ اتحقق' : `الباقي ${n(t.focus.remaining)}${t.behindSlab1 ? ' ⚠ متأخر عن Slab 1' : ''}`) : 'مفيش تارجت')}
  </div>
  <h3>📅 شهرياً</h3>${tbl(['الشهر', d.year, d.cmpYear, 'النمو'], MON.map((m, i) => `<tr><td>${m}</td><td>${i < d.lastMonth || d.curM[i] ? n(d.curM[i]) : '-'}</td><td>${n(d.prevM[i])}</td><td>${i < d.lastMonth ? badge(g(d.curM[i], d.prevM[i])) : ''}</td></tr>`))}
  <h3>📦 الفاميلي</h3>${tbl(['الفاميلي', d.year, d.cmpYear, 'النمو', '% من مبيعاته'], d.families.map((f) => `<tr><td>${esc(f.name)}</td><td>${n(f.cur)}</td><td>${n(f.prev)}</td><td>${badge(g(f.cur, f.prev))}</td><td>${d.total ? Math.round((f.cur / d.total) * 100) : 0}%</td></tr>`))}
  <h3>🛒 أعلى أصناف</h3>${tbl(['الصنف', 'الكمية', d.year, d.cmpYear], d.products.map((p) => `<tr><td dir="ltr">${esc(p.name)}</td><td>${p.qty}</td><td>${n(p.cur)}</td><td>${n(p.prev)}</td></tr>`))}
  <h3>🎯 فرص White Space</h3>${w.missing.length ? tbl(['فاميلي لسه مشتراهاش', 'الأكتر مبيعاً عند باقي التجار'], w.missing.map((m) => `<tr><td>${esc(m.name)}</td><td dir="ltr">${m.suggest.map(esc).join('، ') || '-'}</td></tr>`)) : '<p class="muted">اشترى من كل الفاميلي.</p>'}
  <h3>🏬 مخزونه عنده</h3><p class="muted">${d.stock.items ? `${d.stock.items} صنف مسجّل، ${d.stock.units} قطعة، آخر عدّ ${d.stock.lastDate ? d.stock.lastDate.slice(0, 10) : '-'}. ${d.stock.zero.length ? `<b>فرصة بيع (رصيد صفر):</b> <span dir="ltr">${d.stock.zero.slice(0, 15).map(esc).join('، ')}</span>` : 'مفيش صفر.'}` : 'لسه معملتش عدّ.'}</p>
  <h3>🚚 الإمداد (${d.year})</h3>${s ? `<p class="muted">مطلوب ${n(s.requested)} · اتسلّم ${n(s.delivered)} (${s.fillRate === null ? '-' : s.fillRate + '%'}) · مفتوح ${n(s.open)} · مؤجَّل ${n(s.deferred)}${t.focus && !t.focus.reached ? ` · المفتوح+المؤجَّل (شامل) ${n(s.grossPending)} ${s.closesGap ? '✅ يسد باقي ' + esc(t.focus.name) : 'مش كفاية لباقي ' + esc(t.focus.name)}` : ''}</p>` : '<p class="muted">مفيش طلبيات.</p>'}` + sellOutHtml(customerId, d.year, tbl);
}

function sellOutHtml(cid, year, tbl) {
  const rows = getDealerSellThrough(cid, { from: `${year}-01-01`, to: `${year}-12-31` });
  const so = rows.reduce((s, r) => s + r.sellOut, 0), si = rows.reduce((s, r) => s + r.sellIn, 0);
  if (!so) return `<h3>📤 سيل أوت (البروموتر)</h3><p class="muted">مفيش سيل أوت مسجل للتاجر ده في ${year}.</p>`;
  const zero = rows.filter((r) => r.est !== null && r.est <= 0 && r.sellOut > 0);
  return `<h3>📤 سيل أوت (البروموتر) ${year}</h3><p class="muted">سيل أوت ${n(so)} قطعة مقابل سيل إن ${n(si)} (${si ? Math.round((so / si) * 100) + '%' : '-'}).${zero.length ? ` <b style="color:var(--danger)">⚠ بيبيع أصناف رصيدها التقديري صفر أو أقل: ${zero.slice(0, 10).map((r) => esc(r.sku || r.name)).join('، ')}</b>` : ''}</p>`
    + tbl(['الصنف', 'سيل إن', 'سيل أوت', 'آخر عدّ', 'مخزون تقديري'], rows.filter((r) => r.sellOut || r.sellIn).slice(0, 15).map((r) => `<tr><td dir="ltr">${esc(r.sku || r.name)}</td><td>${n(r.sellIn)}</td><td>${n(r.sellOut)}</td><td>${r.count === null ? '-' : n(r.count)}</td><td>${r.est === null ? '-' : n(r.est)}</td></tr>`));
}
