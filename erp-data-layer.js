/**
 * ============================================================
 *  ERP Data Layer - نظام إدارة المبيعات والمخزون والعملاء
 * ============================================================
 * الفلسفة المعمارية:
 * 1) كل البيانات مخزّنة كـ "جداول" JSON منفصلة داخل localStorage
 *    (مش object واحد ضخم) لتسهيل النسخ الاحتياطي والصيانة.
 * 2) الأرصدة (رصيد العميل / كمية المخزون) لا تُخزَّن كرقم ثابت
 *    يتم تعديله مباشرة، بل تُحسَب دائماً من مجموع الحركات
 *    (Transactions). هذا يمنع تضارب البيانات ويسهّل اكتشاف الأخطاء.
 * 3) أي عملية بيع أو تحصيل تُسجَّل كـ "حركة" في جدولها الخاص
 *    (Ledger / Journal pattern) بدلاً من التعديل المباشر.
 * 4) كل العمليات المركّبة (مثل: تسجيل فاتورة بيع تؤثر على المخزون
 *    والحساب معاً) تمر عبر دوال واحدة تضمن تنفيذ كل الخطوات
 *    أو لا شيء (شبه-Transaction) لتفادي حالات البيانات الناقصة.
 * ============================================================
 */

const STORAGE_KEYS = {
  CUSTOMERS: 'erp_customers',
  PRODUCTS: 'erp_products',
  INVENTORY_TX: 'erp_inventory_transactions',
  SALES_ORDERS: 'erp_sales_orders',
  RETURNS: 'erp_sales_returns',
  AUDIT_LOG: 'erp_audit_log',
  RECEIPTS: 'erp_receipts',
  CHECKS: 'erp_checks',
  TARGETS: 'erp_targets',
  KPIS: 'erp_monthly_kpis',
  REPS: 'erp_sales_reps',
  STOCK_STATUS: 'erp_stock_status_log',
  DEALER_STOCK: 'erp_dealer_stock',
  LEDGER_ADJUSTMENTS: 'erp_ledger_adjustments',
  SETTINGS: 'erp_settings',
  META: 'erp_meta', // آخر تحديث، رقم النسخة، إلخ
};

// ------------------------------------------------------------
// أدوات أساسية عامة (Generic Helpers)
// ------------------------------------------------------------

function generateId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getAll(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error(`فشل قراءة ${key}:`, e);
    return [];
  }
}

function saveAll(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
    localStorage.setItem(STORAGE_KEYS.META, JSON.stringify({ lastUpdated: new Date().toISOString() }));
    return true;
  } catch (e) {
    console.error(`فشل حفظ ${key}:`, e);
    if (typeof alert === "function") alert("⚠ تعذّر حفظ البيانات (المساحة ممتلئة؟) — اعمل نسخة احتياطية فوراً");
    return false;
  }
}

function esc(v) { return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
/** هل التاريخ في الشهر (بتوقيت الجهاز مش UTC) */
function inPeriod(dt, p) { const x = new Date(dt); if (isNaN(x)) return String(dt || '').startsWith(p); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`.startsWith(p); }
/** مرتجعات الفواتير غير الملغاة فقط */
function validReturns() { const v = new Set(getAll(STORAGE_KEYS.SALES_ORDERS).filter((o) => o.voided).map((o) => o.id)); return getAll(STORAGE_KEYS.RETURNS).filter((r) => !v.has(r.orderId)); }
/** كل الفواتير غير الملغاة (شاملة المؤرشفة) — للتقارير والأهداف */
function getReportOrders() { return getAll(STORAGE_KEYS.SALES_ORDERS).filter((o) => !o.voided); }

function addRecord(key, record) {
  const all = getAll(key);
  const newRecord = { id: generateId(), createdAt: new Date().toISOString(), ...record };
  all.push(newRecord);
  if (!saveAll(key, all)) return null; // فشل الحفظ (مساحة ممتلئة مثلاً) — منسجلش نص عملية
  return newRecord;
}

/** تسجيل حدث في سجل التدقيق (تعديل/إلغاء/مرتجع) — نص واضح بالعربي مش تفاصيل تقنية */
function logAudit(orderId, action, details) {
  addRecord(STORAGE_KEYS.AUDIT_LOG, { orderId, action, details, date: new Date().toISOString() });
}

/** سجل تعديلات طلبية معيّنة، الأحدث أولاً */
function getOrderAuditLog(orderId) {
  return getAll(STORAGE_KEYS.AUDIT_LOG)
    .filter((a) => a.orderId === orderId)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

function updateRecord(key, id, changes) {
  const all = getAll(key);
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const updated = { ...all[idx], ...changes, updatedAt: new Date().toISOString() };
  all[idx] = updated;
  if (!saveAll(key, all)) return null; // فشل الحفظ
  return updated;
}

function deleteRecord(key, id) {
  const all = getAll(key);
  const filtered = all.filter((r) => r.id !== id);
  saveAll(key, filtered);
  return filtered.length !== all.length;
}

function initStorage() {
  Object.values(STORAGE_KEYS).forEach((key) => {
    if (localStorage.getItem(key) === null) {
      saveAll(key, key === STORAGE_KEYS.SETTINGS || key === STORAGE_KEYS.META ? {} : []);
    }
  });
}

// ------------------------------------------------------------
// العملاء (Customers)
// ------------------------------------------------------------

function addCustomer({ name, category = 'عام', openingBalance = 0, creditLimit = 0, phone = '', discountRate = 0, code = '', openingBalanceDate = null }) {
  return addRecord(STORAGE_KEYS.CUSTOMERS, { name, code, category, openingBalance, creditLimit, phone, discountRate, openingBalanceDate });
}

/** تاريخ احتساب عمر الرصيد الافتتاحي: التاريخ المحدد له لو موجود، وإلا تاريخ إنشاء العميل */
function openingDateOf(customer) {
  return customer.openingBalanceDate || customer.createdAt;
}

/**
 * رصيد العميل = الرصيد الافتتاحي + إجمالي المبيعات الآجلة - إجمالي التحصيلات
 * (يُحسب دائماً من الحركات، لا يُخزَّن كرقم منفصل)
 * ملاحظة: سندات القبض المُلغاة (شيك ارتد مثلاً) تُستبعد من الحساب - انظر voidReceipt
 */
function getCustomerBalance(customerId) {
  const customer = getAll(STORAGE_KEYS.CUSTOMERS).find((c) => c.id === customerId);
  if (!customer) return 0;

  const totalSales = getAll(STORAGE_KEYS.SALES_ORDERS)
    .filter((o) => o.customerId === customerId && !o.voided)
    .reduce((sum, o) => sum + o.total, 0);

  const totalReceipts = getAll(STORAGE_KEYS.RECEIPTS)
    .filter((r) => r.customerId === customerId && !r.voided)
    .reduce((sum, r) => sum + r.amount, 0);

  const totalReturns = validReturns()
    .filter((r) => r.customerId === customerId)
    .reduce((sum, r) => sum + r.totalValue, 0);

  const totalAdjustments = getAll(STORAGE_KEYS.LEDGER_ADJUSTMENTS)
    .filter((a) => a.customerId === customerId)
    .reduce((sum, a) => sum + a.amount, 0);

  return customer.openingBalance + totalSales - totalReceipts - totalReturns + totalAdjustments;
}

/**
 * رصيد العميل في تاريخ معيّن في الماضي (للمطابقة مع أرقام الساب التاريخية).
 * بيبدأ من الرصيد الافتتاحي (بتاريخه المسجّل) ويجمع عليه كل حركة لحد وبما في ذلك التاريخ المطلوب.
 */
function getCustomerBalanceAsOf(customerId, asOfDate) {
  const customer = getAll(STORAGE_KEYS.CUSTOMERS).find((c) => c.id === customerId);
  if (!customer) return 0;
  const cutoff = new Date(asOfDate);

  const totalSales = getAll(STORAGE_KEYS.SALES_ORDERS)
    .filter((o) => o.customerId === customerId && !o.voided && new Date(o.date) <= cutoff)
    .reduce((sum, o) => sum + o.total, 0);

  const totalReceipts = getAll(STORAGE_KEYS.RECEIPTS)
    .filter((r) => r.customerId === customerId && !r.voided && new Date(r.date) <= cutoff)
    .reduce((sum, r) => sum + r.amount, 0);

  const totalReturns = validReturns()
    .filter((r) => r.customerId === customerId && new Date(r.date) <= cutoff)
    .reduce((sum, r) => sum + r.totalValue, 0);

  const totalAdjustments = getAll(STORAGE_KEYS.LEDGER_ADJUSTMENTS)
    .filter((a) => a.customerId === customerId && new Date(a.date) <= cutoff)
    .reduce((sum, a) => sum + a.amount, 0);

  return customer.openingBalance + totalSales - totalReceipts - totalReturns + totalAdjustments;
}

function getCustomerStatement(customerId) {
  const customer = getAll(STORAGE_KEYS.CUSTOMERS).find((c) => c.id === customerId);
  const openingBalance = customer ? customer.openingBalance : 0;
  const checks = getAll(STORAGE_KEYS.CHECKS);

  const CHECK_STATUS_LABELS = {
    holding: 'في الحيازة',
    delivered_office: 'تم التسليم للمكتب',
    deposited_bank: 'تم الإيداع بالبنك',
    cleared: 'تم التحصيل',
    bounced: 'مرتد',
  };

  const sales = getAll(STORAGE_KEYS.SALES_ORDERS)
    .filter((o) => o.customerId === customerId && !o.voided)
    .map((o) => ({
      date: o.date,
      type: `فاتورة بيع #${o.invoiceNo || '-'} ${o.discountRate > 0 ? ` (خصم ${o.discountRate}%)` : ''}`,
      debit: o.total, credit: 0, ref: o.id,
    }));

  const returns = validReturns()
    .filter((r) => r.customerId === customerId)
    .map((r) => ({ date: r.date, type: 'مرتجع', debit: 0, credit: r.totalValue, ref: r.id }));

  const receipts = getAll(STORAGE_KEYS.RECEIPTS)
    .filter((r) => r.customerId === customerId)
    .flatMap((r) => {
      let type;
      if (r.voided) {
        type = 'تحصيل (ملغي - شيك مرتجع)';
      } else if (r.method === 'check') {
        const check = checks.find((c) => c.receiptId === r.id);
        const dueInfo = check ? ` - استحقاق ${check.dueDate || '-'} - ${CHECK_STATUS_LABELS[check.status] || check.status}` : '';
        type = `تحصيل (شيك)${dueInfo}`;
      } else {
        type = 'تحصيل';
      }
      const ck = checks.find((c) => c.receiptId === r.id);
      if (r.voided) return [
        { date: r.date, type: 'تحصيل (شيك)', debit: 0, credit: r.amount, ref: r.id },
        { date: (ck && ck.bouncedDate) || r.date, type: 'ارتداد الشيك (رجوع المديونية)', debit: r.amount, credit: 0, ref: r.id + '_bounce' },
      ];
      return [{ date: r.date, type, debit: 0, credit: r.amount, ref: r.id }];
    });

  const adjustments = getAll(STORAGE_KEYS.LEDGER_ADJUSTMENTS)
    .filter((a) => a.customerId === customerId)
    .map((a) => ({ date: a.date, type: `${a.docType}${a.note ? ' - ' + a.note : ''}`, debit: a.amount > 0 ? a.amount : 0, credit: a.amount < 0 ? -a.amount : 0, ref: a.id }));

  const movements = [...sales, ...returns, ...receipts, ...adjustments].sort((a, b) => new Date(a.date) - new Date(b.date));

  const openingRow = {
    date: customer ? openingDateOf(customer) : new Date(0).toISOString(),
    type: 'رصيد افتتاحي',
    debit: openingBalance > 0 ? openingBalance : 0,
    credit: openingBalance < 0 ? Math.abs(openingBalance) : 0,
    ref: 'opening',
    balance: openingBalance,
  };

  // رصيد متجمّع (Running Balance) بعد كل حركة، بدايةً من الرصيد الافتتاحي
  let running = openingBalance;
  const rows = movements.map((m) => {
    running += m.debit - m.credit;
    return { ...m, balance: running };
  });

  return [openingRow, ...rows];
}

/**
 * ملخص سريع لموقف العميل: عدد وقيمة فواتيره اللي عليها خصم مقابل اللي من غير خصم
 */
function getCustomerCashCreditMix(customerId) {
  const orders = getAll(STORAGE_KEYS.SALES_ORDERS).filter((o) => o.customerId === customerId && !o.voided);
  const cash = orders.filter((o) => o.discountRate > 0);
  const credit = orders.filter((o) => !(o.discountRate > 0));
  return {
    cashCount: cash.length, cashValue: cash.reduce((s, o) => s + o.total, 0),
    creditCount: credit.length, creditValue: credit.reduce((s, o) => s + o.total, 0),
  };
}

/** العملاء اللي رصيدهم الحالي تعدّى حد الائتمان بتاعهم (حد الائتمان لازم يكون أكبر من صفر عشان يتفعّل) */
function getOverCreditLimitCustomers() {
  return getAll(STORAGE_KEYS.CUSTOMERS)
    .filter((c) => c.creditLimit > 0)
    .map((c) => ({ ...c, balance: getCustomerBalance(c.id) }))
    .filter((c) => c.balance > c.creditLimit);
}

/**
 * تقادم ديون العميل (Aging) بطريقة FIFO: أقدم فاتورة بتتخصم منها
 * التحصيلات أول بأول لحد ما تتغطى بالكامل، والباقي (لو فيه) بيتصنّف
 * حسب عمره من تاريخ الفاتورة: 0-30 / 31-60 / 61-90 / 90+ يوم.
 * الشيكات المرتدة (receipts.voided) مستبعدة من التحصيلات، فبترجع
 * الفاتورة الأصلية تظهر كمديونية قائمة تاني زي ما هي.
 */
function getCustomerAging(customerId) {
  const customer = getAll(STORAGE_KEYS.CUSTOMERS).find((c) => c.id === customerId);
  if (!customer) return { invoices: [], buckets: { d0_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 } };

  const debits = [];
  if (customer.openingBalance > 0) {
    debits.push({ date: openingDateOf(customer), amount: customer.openingBalance, remaining: customer.openingBalance, label: 'رصيد افتتاحي' });
  }
  getAll(STORAGE_KEYS.SALES_ORDERS)
    .filter((o) => o.customerId === customerId && !o.voided)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .forEach((o) => debits.push({ date: o.date, amount: o.total, remaining: o.total, label: 'فاتورة بيع', ref: o.id }));

  debits.sort((a, b) => new Date(a.date) - new Date(b.date));

  const credits = [
    ...getAll(STORAGE_KEYS.RECEIPTS).filter((r) => r.customerId === customerId && !r.voided).map((r) => ({ date: r.date, amount: r.amount })),
    ...validReturns().filter((r) => r.customerId === customerId).map((r) => ({ date: r.date, amount: r.totalValue })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));

  if (customer.openingBalance < 0) credits.unshift({ date: openingDateOf(customer), amount: -customer.openingBalance });
  credits.forEach((r) => {
    let remainingCredit = r.amount;
    for (const debit of debits) {
      if (remainingCredit <= 0) break;
      if (debit.remaining <= 0) continue;
      const applied = Math.min(debit.remaining, remainingCredit);
      debit.remaining -= applied;
      remainingCredit -= applied;
    }
  });

  const now = Date.now();
  const buckets = { d0_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
  const openInvoices = debits.filter((d) => d.remaining > 0.01).map((d) => {
    const ageDays = Math.floor((now - new Date(d.date).getTime()) / (1000 * 60 * 60 * 24));
    let bucket = 'd0_30';
    if (ageDays > 90) bucket = 'd90plus';
    else if (ageDays > 60) bucket = 'd61_90';
    else if (ageDays > 30) bucket = 'd31_60';
    buckets[bucket] += d.remaining;
    return { ...d, ageDays, bucket };
  });

  return { invoices: openInvoices, buckets };
}

/** تقرير تقادم شامل لكل العملاء اللي عليهم مديونية قائمة */
function getAgingReport() {
  return getAll(STORAGE_KEYS.CUSTOMERS)
    .map((c) => ({ customer: c, aging: getCustomerAging(c.id) }))
    .filter((r) => r.aging.invoices.length > 0);
}

// ------------------------------------------------------------
// تقارير سريعة: أكبر العملاء وأكتر المنتجات مبيعاً
// ------------------------------------------------------------

/** أكبر العملاء بيعاً بالقيمة، اختيارياً لفترة معيّنة (period بصيغة YYYY-MM) */
function getTopCustomers(period = null, limit = 5) {
  const orders = getReportOrders().filter((o) => !period || inPeriod(o.date, period));
  const customers = getAll(STORAGE_KEYS.CUSTOMERS);
  const totals = {};
  orders.forEach((o) => { totals[o.customerId] = (totals[o.customerId] || 0) + o.total; });

  // اطرح قيمة المرتجعات المسجّلة في نفس الفترة (صافي مبيعات حقيقي)
  validReturns()
    .filter((r) => !period || inPeriod(r.date, period))
    .forEach((r) => { totals[r.customerId] = (totals[r.customerId] || 0) - r.totalValue; });

  return Object.entries(totals)
    .map(([customerId, total]) => ({ customer: customers.find((c) => c.id === customerId), total }))
    .filter((r) => r.customer)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

/** أكتر المنتجات مبيعاً (بالكمية والقيمة، صافي بعد خصم المرتجعات)، اختيارياً لفترة معيّنة */
function getTopProducts(period = null, limit = 5) {
  const orders = getReportOrders().filter((o) => !period || inPeriod(o.date, period));
  const products = getAll(STORAGE_KEYS.PRODUCTS);
  const totals = {};
  orders.forEach((o) => o.items.forEach((it) => {
    if (!totals[it.productId]) totals[it.productId] = { qty: 0, value: 0 };
    totals[it.productId].qty += it.qty;
    totals[it.productId].value += it.qty * it.unitPrice;
  }));

  validReturns()
    .filter((r) => !period || inPeriod(r.date, period))
    .forEach((r) => r.items.forEach((it) => {
      if (!totals[it.productId]) totals[it.productId] = { qty: 0, value: 0 };
      totals[it.productId].qty -= it.qty;
      totals[it.productId].value -= it.qty * it.unitPrice;
    }));

  return Object.entries(totals)
    .map(([productId, t]) => ({ product: products.find((p) => p.id === productId), ...t }))
    .filter((r) => r.product)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

// ------------------------------------------------------------
// المنتجات والمخزون (Products & Inventory)
// ------------------------------------------------------------

function addProduct({ name, sku, unit = 'قطعة', reorderLevel = 0, openingStock = 0, basePrice = 0, category = '', description = '' }) {
  const product = addRecord(STORAGE_KEYS.PRODUCTS, { name, sku, unit, reorderLevel, basePrice, offerPrice: null, category, description });
  if (openingStock > 0) {
    addInventoryTransaction({ productId: product.id, type: 'in', qty: openingStock, refType: 'opening', refId: null });
  }
  return product;
}

/**
 * عرض مؤقت على منتج: سعر جديد يحل محل السعر الأساسي، وبيتشال لاحقاً
 * يدوياً برجوع السعر الأساسي (clearProductOffer). مفيش تواريخ بداية/نهاية،
 * إنت اللي بتتحكم فيه لما تحطه ولما تشيله.
 */
function setProductOffer(productId, offerPrice) {
  return updateRecord(STORAGE_KEYS.PRODUCTS, productId, { offerPrice });
}

function clearProductOffer(productId) {
  return updateRecord(STORAGE_KEYS.PRODUCTS, productId, { offerPrice: null });
}

/** السعر الفعلي الحالي للمنتج: سعر العرض لو موجود، وإلا السعر الأساسي */
function getEffectivePrice(productId) {
  const product = getAll(STORAGE_KEYS.PRODUCTS).find((p) => p.id === productId);
  if (!product) return 0;
  return product.offerPrice !== null && product.offerPrice !== undefined ? product.offerPrice : product.basePrice;
}

/** خريطة أرصدة كل المنتجات دفعة واحدة (أسرع بكتير من تكرار getProductStock لكل منتج) */
function getStockMap() {
  const map = {};
  getAll(STORAGE_KEYS.INVENTORY_TX).forEach((t) => {
    map[t.productId] = (map[t.productId] || 0) + (t.type === 'in' ? t.qty : -t.qty);
  });
  return map;
}

/** الكمية الحالية لمنتج واحد = مجموع حركات "وارد" - مجموع حركات "صادر" */
function getProductStock(productId) {
  return getAll(STORAGE_KEYS.INVENTORY_TX)
    .filter((t) => t.productId === productId)
    .reduce((sum, t) => sum + (t.type === 'in' ? t.qty : -t.qty), 0);
}

function addInventoryTransaction({ productId, type, qty, refType, refId }) {
  return addRecord(STORAGE_KEYS.INVENTORY_TX, { productId, type, qty, refType, refId, date: new Date().toISOString() });
}

/** يرجع المنتجات اللي وصلت لحد الطلب (Reorder Level) */
function getLowStockAlerts() {
  const stockMap = getStockMap();
  return getAll(STORAGE_KEYS.PRODUCTS)
    .map((p) => ({ ...p, currentStock: stockMap[p.id] || 0 }))
    .filter((p) => p.reorderLevel > 0 && p.currentStock <= p.reorderLevel);
}

/** هل المنتج ده استُخدم في أي فاتورة أو مرتجع؟ (لمنع حذفه لو كده) */
function isProductUsed(productId) {
  return getAll(STORAGE_KEYS.SALES_ORDERS).some((o) => o.items.some((it) => it.productId === productId))
    || getAll(STORAGE_KEYS.RETURNS).some((r) => r.items.some((it) => it.productId === productId));
}

/** خريطة أرصدة كل العملاء دفعة واحدة (أسرع بكتير من تكرار getCustomerBalance لكل عميل) */
function getAllCustomerBalances() {
  const customers = getAll(STORAGE_KEYS.CUSTOMERS);
  const sales = getAll(STORAGE_KEYS.SALES_ORDERS).filter((o) => !o.voided);
  const receipts = getAll(STORAGE_KEYS.RECEIPTS).filter((r) => !r.voided);
  const returns = validReturns();
  const adjustments = getAll(STORAGE_KEYS.LEDGER_ADJUSTMENTS);

  const salesMap = {}, receiptsMap = {}, returnsMap = {}, adjMap = {};
  sales.forEach((o) => { salesMap[o.customerId] = (salesMap[o.customerId] || 0) + o.total; });
  receipts.forEach((r) => { receiptsMap[r.customerId] = (receiptsMap[r.customerId] || 0) + r.amount; });
  returns.forEach((r) => { returnsMap[r.customerId] = (returnsMap[r.customerId] || 0) + r.totalValue; });
  adjustments.forEach((a) => { adjMap[a.customerId] = (adjMap[a.customerId] || 0) + a.amount; });

  const map = {};
  customers.forEach((c) => {
    map[c.id] = c.openingBalance + (salesMap[c.id] || 0) - (receiptsMap[c.id] || 0) - (returnsMap[c.id] || 0) + (adjMap[c.id] || 0);
  });
  return map;
}

/**
 * ATP والكمية الجاية (Incoming) أرقام بتوصلك جاهزة من مصدر خارجي
 * (المصنع / المخزن المركزي) وبتتحدّث كتير على مدار الشهر.
 * بنسجلها كـ "سجل تاريخي" (Log) مش كرقم ثابت بيتم الكتابة فوقه،
 * عشان تقدر ترجع تشوف امتى اتغيّرت والقيمة القديمة قبل التحديث.
 */
function addStockStatusUpdate({ productId, atp = null, incoming = null, orders = null, remaining = null, pxxGroup = '', note = '' }) {
  return addRecord(STORAGE_KEYS.STOCK_STATUS, { productId, atp, incoming, orders, remaining, pxxGroup, note, date: new Date().toISOString() });
}

/**
 * استيراد دوري لملف ATP من الساب (بيتحدّث كل يومين تقريباً).
 * الأعمدة بالترتيب: PXX | VIB (كود الموديل) | Type | Incoming | ATP | Orders | Remaining Qty
 * المطابقة بالكود (VIB) حصراً. المنتج الغير موجود بيتسجل في notFound، والسالب (Backorder) في negative.
 */
function importStockStatus(text) {
  const products = getAll(STORAGE_KEYS.PRODUCTS);
  const byCode = new Map(products.filter((p) => p.sku).map((p) => [p.sku.trim().toLowerCase(), p]));
  const res = { updated: 0, notFound: [], negative: [] };
  const now = new Date().toISOString();
  parseRows(text).forEach(([pxxGroup, vib, type, incoming, atp, orders, remaining]) => {
    if (!vib || vib.trim().toLowerCase() === 'vib') return; // تخطي صف العناوين
    const p = byCode.get(vib.trim().toLowerCase());
    if (!p) { res.notFound.push(vib); return; }
    const rem = remaining === undefined || remaining === '' ? toNum(atp) - toNum(orders) : toNum(remaining);
    addRecord(STORAGE_KEYS.STOCK_STATUS, { productId: p.id, atp: toNum(atp), incoming: toNum(incoming), orders: toNum(orders), remaining: rem, pxxGroup: pxxGroup || '', note: '', date: now });
    res.updated++;
    if (rem < 0) res.negative.push({ sku: p.sku, name: p.name, remaining: rem });
  });
  return res;
}

/** آخر تحديث مسجّل لمنتج معيّن (أو null لو لسه معملوش تحديث) */
function getLatestStockStatus(productId) {
  const logs = getAll(STORAGE_KEYS.STOCK_STATUS)
    .filter((s) => s.productId === productId)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  return logs[0] || null;
}

/** سجل كامل لتحديثات ATP/الجاية لمنتج معيّن، الأحدث أولاً */
function getStockStatusHistory(productId) {
  return getAll(STORAGE_KEYS.STOCK_STATUS)
    .filter((s) => s.productId === productId)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}


// ------------------------------------------------------------
// مخزون التاجر: الكمية اللي موجودة فعلياً عند كل تاجر من كل صنف،
// بتتسجل بالعدّ وقت الزيارة (سجل تاريخي زي ATP، مش رقم بيتكتب فوقه).
// ------------------------------------------------------------

/** الأعمدة: الكود ← الكمية. المطابقة بالكود (SKU) حصراً. */
function importDealerStock(customerId, text) {
  const products = getAll(STORAGE_KEYS.PRODUCTS);
  const byCode = new Map(products.filter((p) => p.sku).map((p) => [p.sku.trim().toLowerCase(), p]));
  const res = { added: 0, notFound: [] };
  const now = new Date().toISOString();
  parseRows(text).forEach(([code, qty]) => {
    if (!code) return;
    const k = code.trim().toLowerCase();
    if (k === 'كود' || k === 'code' || k === 'sku') return;
    const p = byCode.get(k);
    if (!p) { res.notFound.push(code); return; }
    addRecord(STORAGE_KEYS.DEALER_STOCK, { customerId, productId: p.id, qty: toNum(qty), date: now });
    res.added++;
  });
  return res;
}

/** آخر كمية مسجّلة لكل صنف عند تاجر معيّن */
function getDealerStock(customerId) {
  const recs = getAll(STORAGE_KEYS.DEALER_STOCK).filter((r) => r.customerId === customerId);
  const latest = new Map();
  recs.forEach((r) => {
    const cur = latest.get(r.productId);
    if (!cur || new Date(r.date) > new Date(cur.date)) latest.set(r.productId, r);
  });
  return [...latest.values()];
}

/** تاريخ تحديثات صنف معيّن عند تاجر معيّن، الأحدث أولاً */
function getDealerStockHistory(customerId, productId) {
  return getAll(STORAGE_KEYS.DEALER_STOCK)
    .filter((r) => r.customerId === customerId && r.productId === productId)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

/** ملخص كل التجار: عدد الأصناف المسجلة، إجمالي القطع، القيمة التقديرية، آخر تحديث */
function getDealersStockOverview() {
  const products = getAll(STORAGE_KEYS.PRODUCTS);
  const pMap = new Map(products.map((p) => [p.id, p]));
  return getAll(STORAGE_KEYS.CUSTOMERS).map((c) => {
    const stock = getDealerStock(c.id);
    const totalUnits = stock.reduce((s, r) => s + r.qty, 0);
    const totalValue = stock.reduce((s, r) => s + r.qty * (pMap.get(r.productId)?.basePrice || 0), 0);
    const lastDate = stock.reduce((m, r) => (!m || r.date > m ? r.date : m), null);
    return { customer: c, itemsCount: stock.length, totalUnits, totalValue, lastDate };
  });
}

// ------------------------------------------------------------
// عمليات مركّبة: فاتورة بيع (تؤثر على المخزون + حساب العميل معاً)
// ------------------------------------------------------------

/**
 * نسبة الخصم للفاتورة: لو اتحددت نسبة يدوياً (رقم، حتى لو 0) بتتطبق،
 * ولو متحددتش (null / فاضي) بتتاخد تلقائياً من نسبة الخصم المسجلة للعميل.
 */
function resolveDiscountRate(customerId, requested) {
  if (requested !== null && requested !== undefined && requested !== '' && Number.isFinite(Number(requested))) {
    return Math.min(100, Math.max(0, Number(requested)));
  }
  const customer = getAll(STORAGE_KEYS.CUSTOMERS).find((c) => c.id === customerId);
  return customer?.discountRate || 0;
}

/**
 * items: [{ productId, qty, unitPrice }]
 * discountRate: اختياري. لو مااتحددش، بيتطبق خصم العميل المسجل في صفحة العملاء
 * تلقائياً. لو اتحدد (حتى 0) بيحل محله للفاتورة دي بس. بيتسجل بشفافية
 * (subtotal / discountRate / discountAmount / total) عشان تقدر ترجع تتأكد.
 * ملاحظة: سعر العرض (لو موجود على المنتج) بيتطبق دايماً، والخصم فوقه.
 */
function recordSale({ customerId, items, repId = null, discountRate: requestedRate = null, date = new Date().toISOString() }) {
  const subtotal = items.reduce((sum, i) => sum + i.qty * i.unitPrice, 0);
  const discountRate = resolveDiscountRate(customerId, requestedRate);
  const discountAmount = subtotal * (discountRate / 100);
  const total = subtotal - discountAmount;

  // كل صنف بياخد حالته الخاصة + سعر اللستة وقت البيع (عشان لو كان فيه عرض،
  // نسخة العميل تقدر توضح "كان X، عرض Y" حتى لو العرض اتشال بعدين)
  const products = getAll(STORAGE_KEYS.PRODUCTS);
  const itemsWithStatus = items.map((i) => {
    const product = products.find((p) => p.id === i.productId);
    return { ...i, status: i.status || 'confirmed', listPriceAtSale: product ? product.basePrice : i.unitPrice };
  });

  const invoiceNo = getAll(STORAGE_KEYS.SALES_ORDERS).length + 1;

  const order = addRecord(STORAGE_KEYS.SALES_ORDERS, {
    customerId, repId, items: itemsWithStatus, subtotal, cashDiscount: discountRate > 0, discountRate, discountAmount, total, date,
    invoiceNo,                     // رقم فاتورة داخلي تسلسلي بسيط (#1, #2, ...)
    orderNumber: null,             // رقم الطلبية على الساب - بيتدخل يدوي بعدين
    sentByEmail: false,            // تشك بسيط: اتبعتت الطلبية بالإيميل ولا لأ
    orderNumberUpdatedAt: date,    // بداية عد الـ 5 أيام (حجز الكمية على الساب)
    archived: false,               // بيتحول true لما تبدأ شهر جديد
    status: 'unconfirmed',         // Unconfirmed -> Confirmed -> Release -> Delivered (تتغير براحتك في أي وقت)
  });
  if (!order) throw new Error('تعذّر حفظ الفاتورة — المساحة ممتلئة على الأرجح. اعمل نسخة احتياطية وفرّغ مساحة.');

  items.forEach((item) => {
    addInventoryTransaction({
      productId: item.productId,
      type: 'out',
      qty: item.qty,
      refType: 'sales_order',
      refId: order.id,
    });
  });

  return order;
}

/**
 * استيراد أوردرات تاريخية بالتفصيل الكامل (من تصدير الساب).
 * الأعمدة بالترتيب: Document Date (YYYY-MM-DD) | Sales Document | Sold-to Party (كود العميل)
 *   | Material (كود الصنف) | Material Description | Order Quantity | Net Price (سعر الوحدة صافي بعد الضريبة) | Delivery Status
 *
 * - بتتجمّع الأسطر اللي عندها نفس "Sales Document" في طلبية واحدة.
 * - الطلبية بتتسجل مؤرشفة (archived) من غير أي تأثير على المخزون الحالي — الكمية دي خرجت من زمان.
 * - حماية من التكرار: أي "Sales Document" موجود أصلاً برقم طلبية (orderNumber) في النظام بيتخطى.
 * - Net Price بيتضرب × (1 + vatRate/100) عشان يتسق مع تسعير النظام (سعر لست شامل الضريبة)،
 *   ليتوافق مع خصم الضريبة اللي بيتطبق وقت حساب التارجت والـ KPIs.
 * - حالة التسليم: Completed → delivered | Not Delivered → confirmed | Partially Delivered → release
 *   | أي قيمة تانية غير معروفة → confirmed (افتراضي آمن). صف الطلبية اللي كل بنودها Not Relevant بيتستبعد بالكامل.
 * - الصنف اللي كوده مش موجود في الكتالوج الحالي بيتسجّل تلقائياً كمنتج "مؤرشف" (بسعر الاستيراد كسعر مبدئي)
 *   عشان القيمة متضيعش، وبيترجع في autoCreatedProducts عشان تراجعه.
 */
function importHistoricalOrders(text, { cutoffDate = null, vatRate = 14, updateMode = false } = {}) {
  const STATUS_MAP = { Completed: 'delivered', 'Not Delivered': 'confirmed', 'Partially Delivered': 'release' };
  const existingOrders = getAll(STORAGE_KEYS.SALES_ORDERS);
  // في وضع التحديث: الطلبيات المستوردة تاريخياً بس هي اللي ممكن تتستبدل — أي فاتورة دخّلتها إنت يدوياً مش بتتلمس أبداً
  const updatableByNumber = new Map(existingOrders.filter((o) => o.historicalImport).map((o) => [String(o.orderNumber || '').trim(), o]));
  const existingOrderNumbers = new Set(existingOrders.map((o) => String(o.orderNumber || '').trim()).filter(Boolean));
  const customers = getAll(STORAGE_KEYS.CUSTOMERS);
  const customerByCode = new Map(customers.filter((c) => c.code).map((c) => [String(c.code).trim(), c]));
  let products = getAll(STORAGE_KEYS.PRODUCTS);
  const productBySku = new Map(products.filter((p) => p.sku).map((p) => [String(p.sku).trim().toLowerCase(), p]));

  const res = { imported: 0, updated: 0, skippedDuplicate: 0, skippedCustomerNotFound: [], autoCreatedProducts: [], totalValue: 0 };

  // تجميع الأسطر في طلبيات بحسب رقم الـ Sales Document
  const groups = new Map();
  parseRows(text).forEach(([dateStr, salesDoc, custCode, material, materialDesc, qty, netPrice, status]) => {
    if (!salesDoc || salesDoc.trim().toLowerCase() === 'sales document') return; // تخطي صف العناوين
    salesDoc = salesDoc.trim();
    if (cutoffDate && dateStr && dateStr.trim() > cutoffDate) return;
    if (!groups.has(salesDoc)) groups.set(salesDoc, []);
    groups.get(salesDoc).push({ date: (dateStr || '').trim(), custCode: (custCode || '').trim(), material: (material || '').trim(), materialDesc: (materialDesc || '').trim(), qty: toNum(qty), netPrice: toNum(netPrice), status: (status || '').trim() });
  });

  groups.forEach((lines, salesDoc) => {
    const historicalMatch = updatableByNumber.get(salesDoc); // فاتورة مستوردة تاريخياً بنفس الرقم، لو موجودة
    const isManualDuplicate = existingOrderNumbers.has(salesDoc) && !historicalMatch; // رقم موجود لكنه فاتورة يدوية، ميتلمسش أبداً
    if (isManualDuplicate) { res.skippedDuplicate++; return; }
    const updatingExisting = updateMode ? historicalMatch : null;
    if (historicalMatch && !updateMode) { res.skippedDuplicate++; return; } // موجودة تاريخياً ووضع التحديث مقفول
    const relevant = lines.filter((l) => l.status !== 'Not Relevant');
    if (relevant.length === 0) return; // طلبية كل بنودها Not Relevant، متسجلش حاجة

    const customer = customerByCode.get(relevant[0].custCode);
    if (!customer) { res.skippedCustomerNotFound.push(`${salesDoc} (كود ${relevant[0].custCode})`); return; }

    const items = relevant.map((l) => {
      let product = productBySku.get(l.material.toLowerCase());
      const unitPrice = Math.round(l.netPrice * (1 + vatRate / 100) * 100) / 100;
      if (!product) {
        product = addProduct({ name: l.materialDesc || l.material, sku: l.material, category: 'مؤرشف | غير موجود في القايمة الحالية', basePrice: unitPrice, openingStock: 0, reorderLevel: 0, description: 'نشأ تلقائياً من استيراد أوردرات تاريخية' });
        updateRecord(STORAGE_KEYS.PRODUCTS, product.id, { historicalImport: true, discontinued: true });
        productBySku.set(l.material.toLowerCase(), product);
        res.autoCreatedProducts.push(`${l.material} — ${l.materialDesc || l.material}`);
      }
      return { productId: product.id, qty: l.qty, unitPrice, listPriceAtSale: unitPrice, status: STATUS_MAP[l.status] || 'confirmed' };
    });

    const subtotal = items.reduce((s, i) => s + i.qty * i.unitPrice, 0);
    const orderStatus = items.every((i) => i.status === 'delivered') ? 'delivered' : 'confirmed';
    const fields = {
      customerId: customer.id, repId: null, items, subtotal, cashDiscount: false, discountRate: 0, discountAmount: 0, total: subtotal,
      date: relevant[0].date, invoiceNo: salesDoc, orderNumber: salesDoc, sentByEmail: false, orderNumberUpdatedAt: relevant[0].date,
      archived: true, status: orderStatus, historicalImport: true,
    };
    if (updatingExisting) {
      updateRecord(STORAGE_KEYS.SALES_ORDERS, updatingExisting.id, fields);
      res.updated++;
    } else {
      const order = addRecord(STORAGE_KEYS.SALES_ORDERS, fields);
      if (!order) return;
      existingOrderNumbers.add(salesDoc);
      res.imported++;
    }
    res.totalValue += subtotal;
  });

  return res;
}

/**
 * استيراد حركات كشف حساب تاريخية غير الفواتير (تحصيل، شيك مرتد، إشعار دائن/مدين، ضرائب خصم... إلخ).
 * الأعمدة: كود العميل | التاريخ (YYYY-MM-DD) | نوع الحركة | المبلغ (موجب = زيادة مديونية، سالب = تخفيض) | ملاحظة | رقم المستند
 * حماية من التكرار: نفس (العميل + التاريخ + النوع + المبلغ + رقم المستند) بيتخطى لو موجود.
 */
function importLedgerAdjustments(text) {
  const customers = getAll(STORAGE_KEYS.CUSTOMERS);
  const customerByCode = new Map(customers.filter((c) => c.code).map((c) => [String(c.code).trim(), c]));
  const existing = getAll(STORAGE_KEYS.LEDGER_ADJUSTMENTS);
  const existingKeys = new Set(existing.map((a) => `${a.customerId}|${a.date}|${a.docType}|${a.amount}|${a.docNumber || ''}`));

  const res = { imported: 0, skippedDuplicate: 0, skippedCustomerNotFound: [] };
  parseRows(text).forEach(([code, date, docType, amount, note, docNumber]) => {
    if (!code || code.trim().toLowerCase() === 'كود العميل') return;
    code = code.trim();
    const customer = customerByCode.get(code);
    if (!customer) { res.skippedCustomerNotFound.push(`${code} (${date})`); return; }
    const amt = toNum(amount);
    const key = `${customer.id}|${date}|${docType}|${amt}|${docNumber || ''}`;
    if (existingKeys.has(key)) { res.skippedDuplicate++; return; }
    existingKeys.add(key);
    addRecord(STORAGE_KEYS.LEDGER_ADJUSTMENTS, { customerId: customer.id, date, docType: docType || 'حركة', amount: amt, note: note || '', docNumber: docNumber || '', historicalImport: true });
    res.imported++;
  });
  return res;
}

/** تثبيت الرصيد الافتتاحي لمجموعة عملاء دفعة واحدة. الأعمدة: كود العميل | الرصيد الافتتاحي | بتاريخ (YYYY-MM-DD) */
function importOpeningBalances(text) {
  const customers = getAll(STORAGE_KEYS.CUSTOMERS);
  const customerByCode = new Map(customers.filter((c) => c.code).map((c) => [String(c.code).trim(), c]));
  const res = { updated: 0, notFound: [] };
  parseRows(text).forEach(([code, balance, asOf]) => {
    if (!code || code.trim().toLowerCase() === 'كود العميل') return;
    code = code.trim();
    const customer = customerByCode.get(code);
    if (!customer) { res.notFound.push(code); return; }
    updateRecord(STORAGE_KEYS.CUSTOMERS, customer.id, { openingBalance: toNum(balance), openingBalanceDate: asOf || null });
    res.updated++;
  });
  return res;
}

/**
 * تقرير مطابقة: بيقارن رصيدنا المحسوب في تاريخ معيّن مقابل رقم جاهز عندك (من الساب مثلاً).
 * الأعمدة: كود العميل | اسم العميل (اختياري، للعرض بس) | الرصيد المتوقع | بتاريخ (YYYY-MM-DD)
 * بيرجّع الفروق مرتبة من الأكبر للأصغر، عشان تلاقي المشاكل بسرعة.
 */
function getReconciliationReport(text) {
  const customers = getAll(STORAGE_KEYS.CUSTOMERS);
  const customerByCode = new Map(customers.filter((c) => c.code).map((c) => [String(c.code).trim(), c]));
  const rows = [];
  parseRows(text).forEach(([code, name, expected, asOf]) => {
    if (!code || code.trim().toLowerCase() === 'كود العميل') return;
    code = code.trim();
    const customer = customerByCode.get(code);
    const expectedNum = toNum(expected);
    if (!customer) { rows.push({ code, name: name || '?', found: false, expected: expectedNum, actual: null, diff: null, asOf }); return; }
    const actual = Math.round(getCustomerBalanceAsOf(customer.id, asOf) * 100) / 100;
    rows.push({ code, name: customer.name, found: true, expected: expectedNum, actual, diff: Math.round((actual - expectedNum) * 100) / 100, asOf });
  });
  return rows.sort((a, b) => Math.abs(b.diff || 0) - Math.abs(a.diff || 0));
}

/** الحالات المسموحة لأي طلبية أو صنف جواها */
const ORDER_STATUSES = ['unconfirmed', 'confirmed', 'release', 'delivered'];

/** تغيير حالة الطلبية ككل - براحتك في أي وقت */
/** بيختم الصنف بتاريخ التسليم لما يبقى Delivered (التارجت بيتحسب بتاريخ التسليم الفعلي) */
function applyDeliveryStamp(it, status, deliveredAt) {
  if (status === 'delivered') return { ...it, status, deliveredAt: deliveredAt || it.deliveredAt || new Date().toISOString() };
  const { deliveredAt: _dropped, ...rest } = it;
  return { ...rest, status };
}

function updateOrderStatus(orderId, status) {
  const order = getAll(STORAGE_KEYS.SALES_ORDERS).find((o) => o.id === orderId);
  if (!order) return null;
  // لما الطلبية كلها تبقى Delivered، كل أصنافها بتبقى Delivered بتاريخ النهارده (ممكن تعدّل التاريخ من تفاصيل الأصناف)
  const items = status === 'delivered' ? order.items.map((it) => (it.status === 'delivered' ? it : applyDeliveryStamp(it, 'delivered', null))) : order.items;
  return updateRecord(STORAGE_KEYS.SALES_ORDERS, orderId, { status, items });
}

/** تعديل تاريخ تسليم صنف مسلَّم فعلاً (YYYY-MM-DD) — لو سجّلت التسليم متأخر عن تاريخه الحقيقي */
function setOrderItemDeliveredAt(orderId, itemIndex, dateStr) {
  const order = getAll(STORAGE_KEYS.SALES_ORDERS).find((o) => o.id === orderId);
  if (!order || !dateStr) return null;
  const items = order.items.map((it, idx) => (idx === itemIndex && it.status === 'delivered' ? { ...it, deliveredAt: dateStr } : it));
  return updateRecord(STORAGE_KEYS.SALES_ORDERS, orderId, { items });
}

/** تغيير حالة صنف واحد جوه طلبية معيّنة (ممكن يختلف عن حالة باقي الأصناف/الطلبية) */
function updateOrderItemStatus(orderId, itemIndex, status, deliveredAt = null) {
  const order = getAll(STORAGE_KEYS.SALES_ORDERS).find((o) => o.id === orderId);
  if (!order) return null;
  const items = order.items.map((it, idx) => (idx === itemIndex ? applyDeliveryStamp(it, status, deliveredAt) : it));
  return updateRecord(STORAGE_KEYS.SALES_ORDERS, orderId, { items });
}

// ------------------------------------------------------------
// رقم الطلبية على الساب + عد الـ 5 أيام لتجديد حجز الكمية
// ------------------------------------------------------------

/**
 * الساب بيسيب الكمية المحجوزة للطلبية بعد 5 أيام من غير تجديد.
 * كل مرة تدخل/تغيّر رقم الطلبية (يعني جددت الحجز)، العد بيبدأ من
 * جديد. الطلبية اللي وصلت أو قربت من الـ 5 أيام محتاجة رجوع للساب
 * تجديد الحجز فوراً.
 */
function updateOrderNumber(orderId, orderNumber) {
  return updateRecord(STORAGE_KEYS.SALES_ORDERS, orderId, {
    orderNumber,
    orderNumberUpdatedAt: new Date().toISOString(),
  });
}

/** كام يوم فاضل قبل ما الحجز يفضى (صفر أو سالب = فات المعاد) */
function getRenewalDaysLeft(order) {
  const updatedAt = new Date(order.orderNumberUpdatedAt || order.date);
  const diffDays = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24);
  return Math.ceil(5 - diffDays);
}

/** الطلبيات الشغالة (مش مؤرشفة ومش ملغاة) اللي محتاجة تجديد حجز خلال يوم أو فاتها المعاد */
function getOrdersNeedingRenewal() {
  return getActiveOrders()
    .filter((o) => !['delivered', 'release'].includes(o.status))
    .map((o) => ({ ...o, daysLeft: getRenewalDaysLeft(o) }))
    .filter((o) => o.daysLeft <= 1)
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

// ------------------------------------------------------------
// إقفال الشهر (أرشفة كل الطلبيات النشطة وبدء شهر جديد)
// ------------------------------------------------------------

/** الطلبيات النشطة (غير المؤرشفة وغير الملغاة) - دي اللي بتظهر في القوائم والتنبيهات والتقارير */
function getActiveOrders() {
  return getAll(STORAGE_KEYS.SALES_ORDERS).filter((o) => !o.archived && !o.voided);
}

/**
 * تعديل أصناف طلبية موجودة (كمية/سعر/إضافة أو حذف صنف)، مع إعادة حساب
 * الإجمالي والخصم من جديد، وتصحيح حركات المخزون تلقائياً (بيشيل
 * الحركات القديمة المرتبطة بالطلبية ويسجل حركات جديدة تعكس الأصناف
 * المحدّثة، فمايحصلش ازدواج أو نقص في رصيد المخزون).
 */
/** discountRate: undefined = سيب نسبة الطلبية زي ما هي، null/فاضي = خصم العميل الحالي، رقم = النسبة دي */
function updateOrderItems(orderId, newItems, { discountRate: requestedRate } = {}) {
  const order = getAll(STORAGE_KEYS.SALES_ORDERS).find((o) => o.id === orderId);
  if (!order) return null;

  // شيل حركات المخزون القديمة الخاصة بالطلبية دي بس (الطلبية المستوردة تاريخياً ما ليهاش حركات مخزون أصلاً)
  if (!order.historicalImport) {
    const remainingTx = getAll(STORAGE_KEYS.INVENTORY_TX)
      .filter((t) => !(t.refType === 'sales_order' && t.refId === orderId));
    saveAll(STORAGE_KEYS.INVENTORY_TX, remainingTx);
  }

  // حافظ على حالة كل صنف وسعر اللستة الأصلي لو نفس المنتج لسه موجود
  const products = getAll(STORAGE_KEYS.PRODUCTS);
  const itemsWithStatus = newItems.map((it) => {
    const prev = order.items.find((p) => p.productId === it.productId);
    const product = products.find((p) => p.id === it.productId);
    const status = prev?.status || 'confirmed'; // الصنف الجديد Confirmed تلقائياً
    return {
      ...it,
      status,
      ...(status === 'delivered' && prev?.deliveredAt ? { deliveredAt: prev.deliveredAt } : {}),
      listPriceAtSale: prev?.listPriceAtSale ?? (product ? product.basePrice : it.unitPrice),
    };
  });

  const subtotal = itemsWithStatus.reduce((sum, i) => sum + i.qty * i.unitPrice, 0);
  const discountRate = requestedRate === undefined ? (order.discountRate || 0) : resolveDiscountRate(order.customerId, requestedRate);
  const discountAmount = subtotal * (discountRate / 100);
  const total = subtotal - discountAmount;

  const updated = updateRecord(STORAGE_KEYS.SALES_ORDERS, orderId, {
    items: itemsWithStatus, subtotal, cashDiscount: discountRate > 0, discountRate, discountAmount, total,
    editedAt: new Date().toISOString(),
  });
  if (!updated) throw new Error('تعذّر حفظ تعديل الفاتورة — المساحة ممتلئة على الأرجح. اعمل نسخة احتياطية وفرّغ مساحة.');

  if (!order.historicalImport) {
    itemsWithStatus.forEach((item) => {
      addInventoryTransaction({ productId: item.productId, type: 'out', qty: item.qty, refType: 'sales_order', refId: orderId });
    });
  }

  logAudit(orderId, 'تعديل الأصناف', `الإجمالي كان ${order.total.toLocaleString()} وبقى ${total.toLocaleString()}`);

  return updated;
}

/**
 * إلغاء طلبية بالكامل: بيرجع كل كمياتها للمخزون (بيشيل حركات
 * الصادر المرتبطة بيها) وبيستبعدها من رصيد العميل وكشف حسابه
 * وكل التقارير. الطلبية بتفضل محفوظة (voided: true) للمراجعة بس
 * مالهاش أي أثر مالي أو مخزني بعد كده.
 */
function voidOrder(orderId) {
  const order = getAll(STORAGE_KEYS.SALES_ORDERS).find((o) => o.id === orderId);
  if (!order) return null;
  const remainingTx = getAll(STORAGE_KEYS.INVENTORY_TX)
    .filter((t) => !(t.refType === 'sales_order' && t.refId === orderId));
  const retIds = new Set(getAll(STORAGE_KEYS.RETURNS).filter((r) => r.orderId === orderId).map((r) => r.id));
  saveAll(STORAGE_KEYS.INVENTORY_TX, remainingTx.filter((t) => !(t.refType === 'sales_return' && retIds.has(t.refId))));
  logAudit(orderId, 'إلغاء الطلبية', `تم إلغاء الطلبية بالكامل (كانت بقيمة ${order.total.toLocaleString()})`);
  return updateRecord(STORAGE_KEYS.SALES_ORDERS, orderId, { voided: true, voidedAt: new Date().toISOString() });
}

// ------------------------------------------------------------
// مرتجعات المبيعات (Sales Returns / Credit Note)
// ------------------------------------------------------------
/**
 * مرتجع جزئي أو كامل على فاتورة موجودة: بيرجع الكمية المرتجعة
 * للمخزون، وبيتسجل كمستند منفصل (زي إشعار دائن) بيقلل مديونية
 * العميل من غير ما يلمس الفاتورة الأصلية - فتفضل شايف "اتباع كذا،
 * ورجع منه كذا" بوضوح بدل ما تعدّل الفاتورة نفسها.
 * items: [{ productId, qty }] - السعر بيتاخد من نفس سعر الفاتورة الأصلية.
 */
function recordReturn({ orderId, items, date = new Date().toISOString() }) {
  const order = getAll(STORAGE_KEYS.SALES_ORDERS).find((o) => o.id === orderId);
  if (!order) return null;

  const factor = 1 - (order.discountRate || 0) / 100; // المرتجع بنفس صافي الفاتورة بعد الخصم
  const prevReturns = getAll(STORAGE_KEYS.RETURNS).filter((r) => r.orderId === orderId);
  const itemsWithPrice = items.map((it) => {
    const sold = order.items.filter((oi) => oi.productId === it.productId).reduce((s, oi) => s + oi.qty, 0);
    const done = prevReturns.flatMap((r) => r.items).filter((ri) => ri.productId === it.productId).reduce((s, ri) => s + ri.qty, 0);
    if (it.qty > sold - done) throw new Error(`الكمية المرتجعة (${it.qty}) أكبر من المتاح للإرجاع (${sold - done})`);
    const orig = order.items.find((oi) => oi.productId === it.productId);
    return { productId: it.productId, qty: it.qty, unitPrice: (orig ? orig.unitPrice : 0) * factor };
  });
  const totalValue = itemsWithPrice.reduce((sum, i) => sum + i.qty * i.unitPrice, 0);

  const ret = addRecord(STORAGE_KEYS.RETURNS, {
    orderId, customerId: order.customerId, items: itemsWithPrice, totalValue, date,
  });
  if (!ret) throw new Error('تعذّر حفظ المرتجع — المساحة ممتلئة على الأرجح. اعمل نسخة احتياطية وفرّغ مساحة.');

  itemsWithPrice.forEach((it) => {
    addInventoryTransaction({ productId: it.productId, type: 'in', qty: it.qty, refType: 'sales_return', refId: ret.id });
  });

  logAudit(orderId, 'مرتجع', `مرتجع بقيمة ${totalValue.toLocaleString()} (${itemsWithPrice.map((i) => i.qty).join('+')} قطعة)`);

  return ret;
}

/** كل المرتجعات المسجّلة على طلبية معيّنة */
function getOrderReturns(orderId) {
  return validReturns().filter((r) => r.orderId === orderId);
}

/**
 * بداية شهر جديد: الطلبيات المكتملة بس (Release / Delivered) بتتحول أرشيف
 * (مش بتتمسح، بتفضل موجودة في كشف حساب العميل وحساباته زي ما هي) وبتختفي
 * من القوائم والتنبيهات النشطة. الطلبيات اللي لسه Unconfirmed/Confirmed
 * بتفضل ظاهرة عشان محتاجة تجديد حجز على الساب أو تأكيد لسه.
 * force=true بيأرشف كل حاجة بغض النظر عن الحالة.
 */
function startNewMonth({ force = false } = {}) {
  const active = getActiveOrders();
  const toArchive = force ? active : active.filter((o) => ['release', 'delivered'].includes(o.status));
  toArchive.forEach((o) => updateRecord(STORAGE_KEYS.SALES_ORDERS, o.id, { archived: true, archivedAt: new Date().toISOString() }));
  return { archived: toArchive.length, skipped: active.length - toArchive.length };
}

/**
 * تسجيل تحصيل: ينشئ سند قبض دائماً (بيخصم من رصيد العميل فوراً).
 *
 * لو الطريقة "شيك": بيتسجل كمان في جدول الشيكات بحالة 'holding'
 * مع تاريخ الاستحقاق وموعد التسليم/الإيداع المطلوب، عشان تقدر
 * تتابع مساره لحد ما "يتحصّل" فعلياً أو "يرتد".
 */
function recordReceipt({ customerId, amount, method = 'cash', date = new Date().toISOString(), checkDetails = null }) {
  const receipt = addRecord(STORAGE_KEYS.RECEIPTS, { customerId, amount, method, date });

  if (method === 'check' && checkDetails) {
    addRecord(STORAGE_KEYS.CHECKS, {
      customerId,
      receiptId: receipt.id,
      amount,
      checkNumber: checkDetails.checkNumber || '',
      bankName: checkDetails.bankName || '',
      dueDate: checkDetails.dueDate || null,        // تاريخ استحقاق الشيك
      deliveryType: checkDetails.deliveryType || 'office', // 'office' | 'bank'
      deliveryDate: checkDetails.deliveryDate || null,      // موعد التسليم/الإيداع المقرر
      status: 'holding', // holding -> delivered_office / deposited_bank -> cleared | bounced
      receivedDate: date,
    });
  }

  return receipt;
}

// ------------------------------------------------------------
// إدارة الشيكات (Checks) — الحيازة، التسليم/الإيداع، والتحصيل
// ------------------------------------------------------------

/** تحديث حالة تسليم الشيك (وصل للمكتب / اتودع في البنك) */
function updateCheckDelivery(checkId, { status, deliveryDate }) {
  return updateRecord(STORAGE_KEYS.CHECKS, checkId, { status, actualDeliveryDate: new Date().toISOString(), ...(deliveryDate ? { deliveryDate } : {}) });
}

/** تحصيل الشيك فعلياً من البنك */
function markCheckCleared(checkId) {
  const check = getAll(STORAGE_KEYS.CHECKS).find((c) => c.id === checkId);
  if (!check) return null;
  updateRecord(STORAGE_KEYS.CHECKS, checkId, { status: 'cleared', clearedDate: new Date().toISOString() });
  return check;
}

/** الشيك ارتد: يترجع كمديونية على العميل تاني (بإلغاء سند القبض الأصلي) */
function markCheckBounced(checkId) {
  const check = getAll(STORAGE_KEYS.CHECKS).find((c) => c.id === checkId);
  if (!check) return null;
  updateRecord(STORAGE_KEYS.CHECKS, checkId, { status: 'bounced', bouncedDate: new Date().toISOString() });
  if (check.receiptId) {
    updateRecord(STORAGE_KEYS.RECEIPTS, check.receiptId, { voided: true });
  }
  return check;
}

/** الشيكات المستحقة خلال عدد أيام معيّن ولسه في الحيازة أو مودعة ومنتظرة التحصيل */
function getChecksDueSoon(days = 7) {
  const limit = new Date();
  limit.setDate(limit.getDate() + days);
  return getAll(STORAGE_KEYS.CHECKS)
    .filter((c) => ['holding', 'delivered_office', 'deposited_bank'].includes(c.status) && c.dueDate && new Date(c.dueDate) <= limit)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
}

// ------------------------------------------------------------
// استيراد جماعي (لصق من إكسل): تجار ومنتجات
// ------------------------------------------------------------
function parseRows(text) {
  const rows = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const sep = l.includes('\t') ? '\t' : (l.includes(';') ? ';' : ',');
    return l.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''));
  });
  if (rows.length && /^(الاسم|اسم|name|material|item|كود|code|sku|الوصف|description|product|الصنف)/i.test(rows[0][0])) rows.shift(); // تخطي صف العناوين
  return rows;
}
const toNum = (v) => { const n = Number(String(v ?? '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[,٬\s%]/g, '')); return Number.isFinite(n) ? n : 0; };

/** الأعمدة: الاسم | الكود | التصنيف | الهاتف | الرصيد الافتتاحي | حد الائتمان | نسبة الخصم % — الاسم بس هو الإجباري.
 *  المكرر (بالكود أو الاسم) بيتخطى، ولو التاجر موجود من غير كود والكود جه دلوقتي بيتضاف له. */
function importCustomers(text) {
  const all = getAll(STORAGE_KEYS.CUSTOMERS);
  const byName = new Map(all.map((c) => [String(c.name).trim().toLowerCase(), c]));
  const byCode = new Map(all.filter((c) => c.code).map((c) => [String(c.code).trim().toLowerCase(), c]));
  const res = { added: 0, skipped: [], coded: 0 };
  parseRows(text).forEach(([name, code, category, phone, opening, limit, discount]) => {
    if (!name) return;
    const found = (code && byCode.get(code.toLowerCase())) || byName.get(name.toLowerCase());
    if (found) {
      if (code && !found.code) { updateRecord(STORAGE_KEYS.CUSTOMERS, found.id, { code }); res.coded++; }
      else res.skipped.push(name);
      return;
    }
    const c = addCustomer({ name, code: code || '', category: category || 'عام', phone: phone || '', openingBalance: toNum(opening), creditLimit: toNum(limit), discountRate: toNum(discount) });
    byName.set(name.toLowerCase(), c); if (code) byCode.set(code.toLowerCase(), c);
    res.added++;
  });
  return res;
}

/** الأعمدة: الاسم | الكود | التصنيف | السعر | الرصيد الافتتاحي | حد الطلب | الوحدة — المكرر (بالكود، أو بالاسم لو مفيش كود) بيتخطى */
/**
 * archivedOnly: وضع آمن لقوايم أسعار قديمة (سنة فاتت مثلاً) — بيحدّث بس المنتجات اللي اتسجلت تلقائياً من الاستيراد التاريخي
 * (الاسم والتصنيف/الفاميلي والوصف والسعر)، وبيشيل عنها علامة "مؤرشف" عشان تفضل بعد أي مسح. كتالوجك الحالي ما بيتلمسش
 * ومفيش إضافة منتجات جديدة، فالأسعار القديمة مستحيل تكتب فوق الجديدة.
 */
/** منتج مؤرشف/متوقف: بيتحسب في التقارير والمبيعات التاريخية بس، ومش بيظهر في قوايم اختيار الفواتير */
function isProductHidden(p) { return !!(p && (p.discontinued || p.historicalImport)); }
function getActiveProducts() { return getAll(STORAGE_KEYS.PRODUCTS).filter((p) => !isProductHidden(p)); }

// ------------------------------------------------------------
// شجرة التصنيف: القسم (بوتاجازات / MDA / SDA) ← الفاميلي. بتتخزن في category بصيغة "قسم | فاميلي"
// (والبوتاجازات وحدها "بوتاجازات") وعلامة Traditional بتفضل علامة جانبية مش مستوى في الشجرة.
// أي مستوى في الشجرة بيشتغل كهدف أو KPI، لأن hasCat بيطابق أي وسم في المسار.
// ------------------------------------------------------------
const DIVISIONS = ['بوتاجازات', 'MDA', 'SDA'];

/** مسار التصنيف كاملاً بدون علامة Traditional، مثال: ['MDA','بيلت إن','مسطح'] */
function productPath(category) {
  const tags = String(category || '').split('|').map((x) => x.trim()).filter((x) => x && x !== 'Traditional');
  return tags.length ? tags : ['بدون تصنيف'];
}
function productDivision(category) { return productPath(category)[0]; }
/** المسار بعد القسم، مثال: "بيلت إن > مسطح" (فاضي للبوتاجازات) */
function productSubPath(category) { return productPath(category).slice(1).join(' > '); }
function isTraditional(category) { return String(category || '').split('|').map((x) => x.trim()).includes('Traditional'); }

/** القسم صالح لو من الأقسام المعتمدة (غير كده المنتج "غير مصنف" ومحتاج إعادة تصنيف) */
function isClassified(p) { return DIVISIONS.includes(productDivision(p.category)); }

/** بيبني category من القسم ومسار فرعي (نص بفواصل > أو › أو مصفوفة) */
function buildCategory(division, subPath, traditional) {
  const subs = (Array.isArray(subPath) ? subPath : String(subPath || '').split(/[>›]/)).map((x) => String(x).trim()).filter(Boolean);
  const parts = [division, ...subs.filter((x, i) => !(i === 0 && x === division))];
  if (traditional) parts.push('Traditional');
  return parts.join(' | ');
}

function setProductClassification(productId, division, subPath) {
  const p = getAll(STORAGE_KEYS.PRODUCTS).find((x) => x.id === productId);
  if (!p) return false;
  updateRecord(STORAGE_KEYS.PRODUCTS, productId, { category: buildCategory(division, subPath, isTraditional(p.category)) });
  return true;
}

/** تصنيف جماعي. الأعمدة: الكود | القسم | الفاميلي أو المسار (مثلاً: بيلت إن > مسطح). المطابقة بالكود وبتشمل المؤرشف */
function importClassification(text) {
  const bySku = new Map(getAll(STORAGE_KEYS.PRODUCTS).filter((p) => p.sku).map((p) => [p.sku.trim().toLowerCase(), p]));
  const res = { updated: 0, notFound: [], badDivision: [] };
  parseRows(text).forEach(([code, division, family]) => {
    if (!code || ['كود', 'code', 'sku'].includes(code.trim().toLowerCase())) return;
    const p = bySku.get(code.trim().toLowerCase());
    if (!p) { res.notFound.push(code); return; }
    const div = DIVISIONS.find((d) => d.toLowerCase() === String(division || '').trim().toLowerCase());
    if (!div) { res.badDivision.push(`${code} (${division || 'فاضي'})`); return; }
    setProductClassification(p.id, div, family);
    res.updated++;
  });
  return res;
}

/** المسار المقترح لمنتج: من تصنيفه الحالي لو معروف، وإلا من وصفه/اسمه. null لو مش قادر يحدد */
function suggestClassification(p) {
  const tags = productPath(p.category);
  const text = `${p.name || ''} ${p.description || ''}`.toLowerCase();
  const hasFridge = /ثلاجة|fridge|refrigerator/.test(text), hasFreezer = /فريزر|freezer/.test(text);
  if (DIVISIONS.includes(tags[0])) {
    if (tags[0] === 'بوتاجازات') return ['بوتاجازات'];
    if (tags[0] === 'SDA') return tags;
    if (tags[0] === 'MDA') {
      if (tags.includes('بيلت إن') || tags.includes('ديب فريزر')) return tags;
      const last = tags[tags.length - 1];
      if (last === 'ثلاجات') return hasFreezer && !hasFridge ? ['MDA', 'ديب فريزر'] : ['MDA', 'ثلاجات'];
      if (last === 'مواقد') return ['MDA', 'بيلت إن', 'مسطح'];
      if (last === 'أفران') return ['MDA', 'بيلت إن', 'فرن'];
      return tags;
    }
  }
  const rules = [
    [/microwave|ميكرو/, ['SDA', 'تحضير الطعام']],
    [/dishwasher|غسالة اطباق|غسالة أطباق/, ['MDA', 'غسالات أطباق']],
    [/washing machine|frontloader|غسالة/, ['MDA', 'غسالات ملابس']],
    [/chimney|hood|شفاط/, ['MDA', 'شفاطات']],
    [/gas range|range cooker|cooker|بوتاجاز/, ['بوتاجازات']],
    [/hob|cooktop|مسطح|موقد|مواقد/, ['MDA', 'بيلت إن', 'مسطح']],
    [/oven|فرن/, ['MDA', 'بيلت إن', 'فرن']],
    [/fridge|refrigerator|ثلاجة/, ['MDA', 'ثلاجات']],
    [/freezer|فريزر/, ['MDA', 'ديب فريزر']],
    [/vacuum|مكنسة/, ['SDA', 'مكانس']],
    [/coffee|kettle|juicer|قهوة|غلاية|عصارة/, ['SDA', 'مشروبات']],
    [/blender|mixer|mincer|processor|kitchen machine|grinder|مفرمة|خلاط|عجان/, ['SDA', 'تحضير الطعام']],
  ];
  const hit = rules.find(([re]) => re.test(text));
  return hit ? hit[1] : null;
}

/** إعادة تصنيف تلقائي لكل المنتجات (نشطة ومؤرشفة) حسب الشجرة. اللي مش قادر يحدده بيرجع في unresolved للتصنيف اليدوي */
function applyAutoClassification() {
  const res = { changed: 0, unchanged: 0, unresolved: [] };
  getAll(STORAGE_KEYS.PRODUCTS).forEach((p) => {
    const path = suggestClassification(p);
    if (!path) { res.unresolved.push(p.sku || p.name); return; }
    const category = buildCategory(path[0], path.slice(1), isTraditional(p.category));
    if (category === p.category) { res.unchanged++; return; }
    updateRecord(STORAGE_KEYS.PRODUCTS, p.id, { category });
    res.changed++;
  });
  return res;
}

/** شجرة التصنيف متداخلة بأي عمق: [{name, count, children:[...], products:[...]}] (النشطة بس افتراضياً) */
function getCategoryTree({ includeHidden = false } = {}) {
  const root = new Map();
  getAll(STORAGE_KEYS.PRODUCTS).filter((p) => includeHidden || !isProductHidden(p)).forEach((p) => {
    let level = root, node = null;
    productPath(p.category).forEach((tag) => {
      if (!level.has(tag)) level.set(tag, { name: tag, count: 0, products: [], kids: new Map() });
      node = level.get(tag); node.count++; level = node.kids;
    });
    node.products.push(p);
  });
  const order = (d) => { const i = DIVISIONS.indexOf(d); return i === -1 ? 99 : i; };
  const toArr = (m, top) => [...m.values()]
    .sort((a, b) => (top ? order(a.name) - order(b.name) : 0) || a.name.localeCompare(b.name, 'ar'))
    .map((n) => ({ name: n.name, count: n.count, products: n.products, children: toArr(n.kids, false) }));
  return toArr(root, true);
}

/**
 * مسح قايمة الأسعار الحالية: المنتج اللي اتباع في أي فاتورة بيتأرشف (يتشال من الفواتير الجديدة ويفضل للتحليل بس)،
 * واللي عمره ما اتباع بيتمسح نهائياً. بعدها حمّل القايمة الجديدة، وأي كود مطابق بيرجع نشط بالاسم والسعر الجديد.
 */
function archiveOrDeleteCatalog() {
  const res = { archived: 0, deleted: 0 };
  getAll(STORAGE_KEYS.PRODUCTS).forEach((p) => {
    if (isProductUsed(p.id)) {
      if (!p.discontinued) { updateRecord(STORAGE_KEYS.PRODUCTS, p.id, { discontinued: true }); res.archived++; }
    } else {
      deleteRecord(STORAGE_KEYS.PRODUCTS, p.id); res.deleted++;
    }
  });
  return res;
}

/**
 * مزامنة الكتالوج مع قايمة الأسعار الحالية: أي منتج (له كود) مش موجود في القايمة بيتأرشف (يختفي من الفواتير ويفضل في التحليل)،
 * واللي موجود فيها بيرجع نشط. refresh=true بيحدّث كمان الاسم والتصنيف والسعر من نفس القايمة (بيصلّح أي تغيير جه بالغلط من قايمة قديمة).
 * المنتجات من غير كود ما بتتلمسش.
 */
function syncCatalogToList(text, { refresh = true } = {}) {
  const res = { updated: 0, added: 0, hidden: 0, restored: 0, untouchedNoSku: 0, inListCount: 0 };
  const rows = parseRows(text).filter(([name]) => name);
  const inList = new Set(rows.map((r) => (r[1] || '').trim().toLowerCase()).filter(Boolean));
  res.inListCount = inList.size;
  if (refresh) { const r = importProducts(text, { update: true }); res.updated = r.updated; res.added = r.added; }
  getAll(STORAGE_KEYS.PRODUCTS).forEach((p) => {
    if (!p.sku) { res.untouchedNoSku++; return; }
    const listed = inList.has(p.sku.trim().toLowerCase());
    if (listed && (p.discontinued || p.historicalImport)) { updateRecord(STORAGE_KEYS.PRODUCTS, p.id, { discontinued: false, historicalImport: false }); res.restored++; }
    else if (!listed && !p.discontinued) { updateRecord(STORAGE_KEYS.PRODUCTS, p.id, { discontinued: true }); res.hidden++; }
  });
  return res;
}

function importProducts(text, { update = false, archivedOnly = false } = {}) {
  const map = new Map(getAll(STORAGE_KEYS.PRODUCTS).map((p) => [(p.sku || p.name).trim().toLowerCase(), p]));
  const touched = new Set();
  const res = { added: 0, skipped: [], updated: 0, priceChanges: [], withOffer: [], missing: [], skippedCurrent: 0, notInSystem: 0, namedArchived: [] };
  parseRows(text).forEach(([name, sku, category, price, opening, reorder, unit, description]) => {
    if (!name) return;
    const k = (sku || name).trim().toLowerCase();
    const old = map.get(k);
    if (archivedOnly) {
      if (!old) { res.notInSystem++; return; }
      if (!old.historicalImport) { res.skippedCurrent++; return; }
      const priceGiven = String(price ?? '').trim() !== '';
      updateRecord(STORAGE_KEYS.PRODUCTS, old.id, { name, category: category || old.category, basePrice: priceGiven ? toNum(price) : old.basePrice, description: description || old.description, historicalImport: false, discontinued: true });
      touched.add(k); res.updated++; res.namedArchived.push(old.sku || name);
      return;
    }
    if (old) {
      const wasHidden = isProductHidden(old); // لو القايمة دي هي الحالية، المنتج المؤرشف بيرجع نشط بدل ما يتخطى
      if (!update && !wasHidden) { res.skipped.push(sku || name); return; }
      if (wasHidden) res.reactivated = (res.reactivated || 0) + 1;
      touched.add(k);
      // خانة السعر فاضية = سيب السعر القديم زي ما هو، متصفّرهوش
      const priceGiven = String(price ?? '').trim() !== '';
      const newPrice = priceGiven ? toNum(price) : old.basePrice;
      if (priceGiven && newPrice !== old.basePrice) res.priceChanges.push({ sku: old.sku || old.name, from: old.basePrice, to: newPrice });
      updateRecord(STORAGE_KEYS.PRODUCTS, old.id, { name, category: category || old.category, basePrice: newPrice, description: description || old.description, discontinued: false, historicalImport: false });
      if (old.offerPrice !== null && old.offerPrice !== undefined) res.withOffer.push(old.sku || old.name);
      res.updated++;
      return;
    }
    const p = addProduct({ name, sku: sku || '', category: category || '', basePrice: toNum(price), openingStock: toNum(opening), reorderLevel: toNum(reorder), unit: unit || 'قطعة', description: description || '' });
    map.set(k, p); touched.add(k); res.added++;
  });
  if (update && !archivedOnly) res.missing = [...map.entries()].filter(([k]) => !touched.has(k)).map(([, p]) => p.sku || p.name);
  return res;
}

// ------------------------------------------------------------
// مندوبو المبيعات (Sales Reps)
// ------------------------------------------------------------

function addRep({ name, phone = '' }) {
  return addRecord(STORAGE_KEYS.REPS, { name, phone });
}

// ------------------------------------------------------------
// الأهداف والعمولات (Targets & Commissions)
// ------------------------------------------------------------

/**
 * entityType: 'customer' | 'rep'
 * period: مثال '2026-09' (شهري) أو '2026' (سنوي)
 */
function setTarget({ entityType, entityId, period, targetAmount, commissionRate = 0, vatRate = 14 }) {
  return addRecord(STORAGE_KEYS.TARGETS, { entityType, entityId, period, targetAmount, commissionRate, vatRate: Number(vatRate) || 0 });
}

/**
 * الإنجاز الفعلي = مجموع المبيعات لنفس الكيان في نفس الفترة، بعد استخراج ضريبة
 * القيمة المضافة من سعر اللست (القيمة ÷ (1 + vatRate/100))، عشان "المحقق" يبقى
 * صافي القيمة الحقيقية مش شامل الضريبة. لو target.vatRate = 0 مفيش استخراج خالص.
 */
function getTargetProgress(targetId) {
  const target = getAll(STORAGE_KEYS.TARGETS).find((t) => t.id === targetId);
  if (!target) return null;
  const mine = (x) => (target.entityType === 'customer' ? x.customerId : x.repId) === target.entityId;
  const gross = getDeliveredLines().filter((l) => mine(l) && inPeriod(l.date, target.period)).reduce((s, l) => s + l.value, 0)
    - getDeliveredReturns().filter((r) => mine(r) && inPeriod(r.date, target.period)).reduce((s, r) => s + r.value, 0);
  const achieved = gross / (1 + (target.vatRate || 0) / 100);
  const percentage = target.targetAmount > 0 ? (achieved / target.targetAmount) * 100 : 0;
  const commission = achieved * (target.commissionRate / 100);
  return { ...target, achieved, percentage: Math.round(percentage * 100) / 100, commission };
}

// ------------------------------------------------------------
// التارجت الشهري الخاص بيك (KPIs متغيّرة كل شهر بأوزان مختلفة)
// ------------------------------------------------------------
/**
 * ده تارجتك إنت الشخصي (مش تارجت لكل ديلر). كل شهر بتحدد مجموعة
 * KPIs مختلفة، كل واحد بنسبة وزن مختلفة من الإجمالي (لازم يجمعوا
 * 100% تقريباً بس النظام مايجبركش على كده - المسؤولية عليك).
 *
 * metricType بيحدد إزاي "المحقق" بيتحسب تلقائياً من الفواتير الحقيقية:
 * - 'total_value'     : إجمالي قيمة كل الفواتير في الفترة
 * - 'category_value'  : إجمالي قيمة الأصناف من تصنيف معيّن (زي MDA)
 * - 'category_count'  : إجمالي عدد القطع من تصنيف معيّن (زي بوتاجازات)
 * - 'active_dealers'  : عدد العملاء اللي وصلتهم طلبية واحدة (Delivered) على الأقل
 *
 * vatRate (لأنواع القيمة بس، افتراضي 14): بيتخصم كاستخراج ضريبة حقيقي
 * (المحقق ÷ (1 + vatRate/100))، على اعتبار إن سعر اللست شامل الضريبة جواه.
 * سيبه 0 لو مش عايز أي استخراج ضريبة لهذا الـ KPI.
 * deductionPercent (اختياري، لأنواع القيمة بس، بيتطبق بعد الضريبة): خصم إضافي
 * بسيط بالنسبة المئوية فوق الصافي (زي خصم ترويجي أو تحفظي إضافي، مش ضريبة).
 * onlyDelivered (اختياري): يحسب بس من الطلبيات اللي حالتها Delivered.
 */
function addKpi({ period, name, metricType, category = null, weight, targetValue, deductionPercent = 0, onlyDelivered = false, minFamilies = 4, vatRate = 14, manualPercent = null }) {
  return addRecord(STORAGE_KEYS.KPIS, { period, name, metricType, category, weight, targetValue, deductionPercent, onlyDelivered, minFamilies: Math.max(Number(minFamilies) || 4, 4), vatRate: Number(vatRate) || 0, manualPercent });
}

/** التصنيف ممكن يكون أكتر من وسم بينهم | مثلاً: MDA | بوتاجازات — الـ KPI بيطابق أي وسم منهم */
function hasCat(cat, k) { return String(cat || '').split('|').map((x) => x.trim()).includes(String(k || '').trim()); }

/** أدق تصنيف فرعي (الفاميلي) من سلسلة التصنيف، مع تجاهل علامة "Traditional" */
function productFamily(category) {
  const parts = String(category || '').split('|').map((x) => x.trim()).filter((x) => x && x !== 'Traditional');
  return parts.length ? parts[parts.length - 1] : 'بدون تصنيف';
}

// ------------------------------------------------------------
// تحليل البيانات: فاميلي / منتج / عميل / نظرة عامة، شهري/ربعي/سنوي/إجمالي،
// مع اتجاه زمني ومقارنة بنفس الفترة في السنة اللي فاتت، وتنبيهات ذكية.
// كل الحسابات المالية بترجع صافي بعد استخراج الضريبة (القيمة ÷ (1+vatRate/100)).
// ------------------------------------------------------------

/** كل الفاميلي المميزة الموجودة في الكتالوج الحالي، مرتبة أبجدياً */
function getFamilies() {
  const fams = new Set(getAll(STORAGE_KEYS.PRODUCTS).map((p) => productFamily(p.category)));
  return [...fams].sort((a, b) => a.localeCompare(b, 'ar'));
}

/** مفتاح الفترة لتاريخ معيّن حسب الدقة المطلوبة */
function periodKey(dateStr, granularity) {
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const y = d.getFullYear();
  const m = d.getMonth() + 1; // 1-12
  if (granularity === 'month') return `${y}-${String(m).padStart(2, '0')}`;
  if (granularity === 'quarter') return `${y}-Q${Math.ceil(m / 3)}`;
  if (granularity === 'year') return `${y}`;
  return 'all';
}

/** مفتاح نفس الفترة بالظبط بس قبل N سنة (للمقارنة السنوية) */
function shiftPeriodKeyYears(key, granularity, yearsBack = 1) {
  if (granularity === 'all' || !key) return null;
  if (granularity === 'month') {
    const [y, m] = key.split('-');
    return `${Number(y) - yearsBack}-${m}`;
  }
  if (granularity === 'quarter') {
    const [y, q] = key.split('-Q');
    return `${Number(y) - yearsBack}-Q${q}`;
  }
  if (granularity === 'year') return String(Number(key) - yearsBack);
  return null;
}

/** تسمية عرض مفهومة للمفتاح */
function periodLabel(key, granularity) {
  if (!key) return '-';
  if (granularity === 'month') {
    const [y, m] = key.split('-');
    const names = ['', 'يناير', 'فبراير', 'مارس', 'إبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    return `${names[Number(m)]} ${y}`;
  }
  return key; // quarter/year/all أسمائهم واضحة زي ما هي
}

/**
 * بيحوّل كل الطلبيات (الحالية + المؤرشفة + التاريخية) لقايمة "أسطر" مسطّحة،
 * كل سطر فيه صنف واحد من طلبية، بالفاميلي والعميل والتاريخ وصافي القيمة بعد الضريبة.
 * أساس كل حسابات التحليل.
 */
function getAnalyticsLines(vatRate = 14) {
  const products = getAll(STORAGE_KEYS.PRODUCTS);
  const pMap = new Map(products.map((p) => [p.id, p]));
  const customers = getAll(STORAGE_KEYS.CUSTOMERS);
  const cMap = new Map(customers.map((c) => [c.id, c]));
  const returns = validReturns();
  const returnsByOrder = new Map();
  returns.forEach((r) => {
    if (!returnsByOrder.has(r.orderId)) returnsByOrder.set(r.orderId, []);
    returnsByOrder.get(r.orderId).push(r);
  });
  const vatDivisor = 1 + (vatRate || 0) / 100;

  const lines = [];
  getReportOrders().forEach((o) => {
    const customer = cMap.get(o.customerId);
    o.items.forEach((it) => {
      const p = pMap.get(it.productId);
      lines.push({
        date: o.date,
        customerId: o.customerId,
        customerName: customer ? customer.name : '(محذوف)',
        productId: it.productId,
        productName: p ? p.name : '(منتج محذوف)',
        family: p ? productFamily(p.category) : 'بدون تصنيف',
        qty: it.qty,
        value: (it.qty * it.unitPrice) / vatDivisor,
      });
    });
    // المرتجعات بتتخصم كسطر سالب بنفس الصنف والفاميلي، بنفس تاريخ المرتجع
    (returnsByOrder.get(o.id) || []).forEach((r) => {
      r.items.forEach((ri) => {
        const p = pMap.get(ri.productId);
        lines.push({
          date: r.date,
          customerId: o.customerId,
          customerName: customer ? customer.name : '(محذوف)',
          productId: ri.productId,
          productName: p ? p.name : '(منتج محذوف)',
          family: p ? productFamily(p.category) : 'بدون تصنيف',
          qty: -ri.qty,
          value: -(ri.qty * (ri.unitPrice || 0)) / vatDivisor,
        });
      });
    });
  });
  return lines;
}

/**
 * مسح كل البيانات التاريخية المستوردة (أوردرات + حركات كشف + منتجات اتسجلت تلقائياً)
 * عشان تقدر تعيد الاستيراد من جديد لو محتاج ترجع لسنين أكتر ورا أو تصحّح حاجة.
 * الفواتير والبيانات اللي دخلتها إنت بنفسك يدوياً مش بتتأثر خالص.
 * الرصيد الافتتاحي بيترجع صفر للعملاء اللي كان متحط لهم من الاستيراد (اللي ليهم openingBalanceDate).
 */
function clearHistoricalImports() {
  const ordersBefore = getAll(STORAGE_KEYS.SALES_ORDERS);
  const remainingOrders = ordersBefore.filter((o) => !o.historicalImport);
  const removedOrders = ordersBefore.length - remainingOrders.length;
  saveAll(STORAGE_KEYS.SALES_ORDERS, remainingOrders);

  const adjBefore = getAll(STORAGE_KEYS.LEDGER_ADJUSTMENTS);
  const remainingAdj = adjBefore.filter((a) => !a.historicalImport);
  const removedAdj = adjBefore.length - remainingAdj.length;
  saveAll(STORAGE_KEYS.LEDGER_ADJUSTMENTS, remainingAdj);

  const prodBefore = getAll(STORAGE_KEYS.PRODUCTS);
  const remainingProd = prodBefore.filter((p) => !p.historicalImport);
  const removedProd = prodBefore.length - remainingProd.length;
  saveAll(STORAGE_KEYS.PRODUCTS, remainingProd);

  let resetBalances = 0;
  getAll(STORAGE_KEYS.CUSTOMERS).forEach((c) => {
    if (c.openingBalanceDate) { updateRecord(STORAGE_KEYS.CUSTOMERS, c.id, { openingBalance: 0, openingBalanceDate: null }); resetBalances++; }
  });

  return { removedOrders, removedAdj, removedProd, resetBalances };
}


// ------------------------------------------------------------
// التارجت الشهري: المحقق بيتحسب من المسلَّم فعلياً (Delivered) وبتاريخ التسليم
// ------------------------------------------------------------
function getSetting(name, fallback) {
  const st = getAll(STORAGE_KEYS.SETTINGS);
  return st && !Array.isArray(st) && name in st ? st[name] : fallback;
}
function setSetting(name, value) {
  const st = getAll(STORAGE_KEYS.SETTINGS);
  const obj = st && !Array.isArray(st) ? st : {};
  obj[name] = value;
  saveAll(STORAGE_KEYS.SETTINGS, obj);
}

/** فاميلي الـ White Space: كل فاميلي ليها اسم وقايمة وسوم (من شجرة التصنيف) بتتحسب عليها. تتعدّل من صفحة الأهداف */
const DEFAULT_WHITESPACE_GROUPS = [
  { name: 'بوتاجازات', tags: ['بوتاجازات'] },
  { name: 'غسالات أطباق', tags: ['غسالات أطباق'] },
  { name: 'غسالات ملابس', tags: ['غسالات ملابس'] },
  { name: 'ثلاجات', tags: ['ثلاجات', 'ديب فريزر'] },
  { name: 'بيلت إن', tags: ['بيلت إن', 'شفاطات'] },
  { name: 'SDA', tags: ['SDA'] },
];
function getWhiteSpaceGroups() { return getSetting('whiteSpaceGroups', DEFAULT_WHITESPACE_GROUPS); }
function setWhiteSpaceGroups(groups) { setSetting('whiteSpaceGroups', groups); }
/** حد أقصى 100% للإنجاز في حساب السكور (افتراضي مفعّل) */
function getTargetCap() { return getSetting('targetCap100', true); }
function setTargetCap(v) { setSetting('targetCap100', !!v); }

/** كل أسطر المبيعات المسلَّمة فعلياً (الصنف حالته Delivered) بتاريخ تسليمها، وقيمتها بعد خصم الطلبية (شاملة الضريبة) */
function getDeliveredLines() {
  const pMap = new Map(getAll(STORAGE_KEYS.PRODUCTS).map((p) => [p.id, p]));
  const lines = [];
  getReportOrders().forEach((o) => {
    const factor = 1 - (o.discountRate || 0) / 100;
    o.items.forEach((it) => {
      if (it.status !== 'delivered') return;
      const p = pMap.get(it.productId);
      lines.push({
        orderId: o.id, customerId: o.customerId, repId: o.repId || null, productId: it.productId,
        productName: p ? p.name : '(منتج محذوف)', category: p ? p.category : '',
        qty: it.qty, value: it.qty * it.unitPrice * factor, date: it.deliveredAt || o.deliveredAt || o.date,
      });
    });
  });
  return lines;
}

/** المرتجعات المرتبطة بأصناف مسلَّمة فعلاً، بتاريخ المرتجع */
function getDeliveredReturns() {
  const orders = getReportOrders();
  const oMap = new Map(orders.map((o) => [o.id, o]));
  const delivered = new Set();
  orders.forEach((o) => o.items.forEach((it) => { if (it.status === 'delivered') delivered.add(`${o.id}|${it.productId}`); }));
  const pMap = new Map(getAll(STORAGE_KEYS.PRODUCTS).map((p) => [p.id, p]));
  const out = [];
  validReturns().forEach((r) => {
    const o = oMap.get(r.orderId);
    if (!o) return;
    r.items.forEach((ri) => {
      if (!delivered.has(`${r.orderId}|${ri.productId}`)) return;
      const p = pMap.get(ri.productId);
      out.push({ orderId: r.orderId, customerId: o.customerId, repId: o.repId || null, productId: ri.productId, category: p ? p.category : '', qty: ri.qty, value: ri.qty * (ri.unitPrice || 0), date: r.date });
    });
  });
  return out;
}

/** تفاصيل رقم كل KPI: مين العملاء والمنتجات اللي كوّنوه (للمراجعة ومقارنة الأرقام) */
function getKpiDetails(kpiId) {
  const kpi = getAll(STORAGE_KEYS.KPIS).find((k) => k.id === kpiId);
  if (!kpi || kpi.metricType === 'manual_percent') return null;
  if (kpi.metricType === 'white_space_dealers') return { kind: 'whitespace', rows: getWhiteSpaceDetail(kpi) };
  const customers = new Map(getAll(STORAGE_KEYS.CUSTOMERS).map((c) => [c.id, c.name]));
  const lines = getDeliveredLines().filter((l) => inPeriod(l.date, kpi.period) && (!kpi.category || kpi.metricType === 'total_value' || hasCat(l.category, kpi.category)));
  const vatDiv = 1 + (kpi.vatRate || 0) / 100;
  const agg = (keyFn, nameFn) => {
    const m = new Map();
    lines.forEach((l) => { const k = keyFn(l); const a = m.get(k) || { name: nameFn(l), value: 0, qty: 0 }; a.value += l.value / vatDiv; a.qty += l.qty; m.set(k, a); });
    return [...m.values()].map((a) => ({ ...a, value: Math.round(a.value * 100) / 100 })).sort((a, b) => (kpi.metricType === 'category_count' ? b.qty - a.qty : b.value - a.value));
  };
  return { kind: 'lines', byCustomer: agg((l) => l.customerId, (l) => customers.get(l.customerId) || '(محذوف)'), byProduct: agg((l) => l.productId, (l) => l.productName) };
}

/** إجمالي القيمة المسلَّمة صافي بعد الضريبة في شهر معيّن (للشريط العلوي) */
function getPeriodTotalValue(period, vatRate = 14) {
  return Math.round(computeKpiAchieved({ period, metricType: 'total_value', vatRate }) * 100) / 100;
}

/** قالب KPIs الشهرية: نفس لوحة الـ Power BI */
const TARGET_TEMPLATE = [
  { key: 'dealers', name: 'Dealers', metricType: 'active_dealers', defaultWeight: 10, unit: 'تاجر' },
  { key: 'fs90', name: 'FS90', metricType: 'category_count', category: 'بوتاجازات', defaultWeight: 20, unit: 'قطعة' },
  { key: 'mda', name: 'MDA', metricType: 'category_value', category: 'MDA', defaultWeight: 35, unit: 'ج.م' },
  { key: 'overdue', name: 'OverDue', metricType: 'manual_percent', defaultWeight: 10, unit: '%' },
  { key: 'sda', name: 'SDA', metricType: 'category_value', category: 'SDA', defaultWeight: 10, unit: 'ج.م' },
  { key: 'whitespace', name: 'WhiteSpace', metricType: 'white_space_dealers', defaultWeight: 15, unit: 'تاجر' },
];

function previousPeriod(period) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** صفوف فورم تارجت الشهر: المحفوظ للشهر ده، وإلا أرقام الشهر اللي فات كنقطة بداية */
function getMonthlyTargetsForm(period) {
  const all = getAll(STORAGE_KEYS.KPIS);
  const cur = all.filter((k) => k.period === period), prev = all.filter((k) => k.period === previousPeriod(period));
  return TARGET_TEMPLATE.map((t) => {
    const saved = cur.find((k) => k.name === t.name), src = saved || prev.find((k) => k.name === t.name);
    return { ...t, weight: src ? src.weight : t.defaultWeight, targetValue: src ? src.targetValue : '', manualPercent: src && src.manualPercent !== undefined && src.manualPercent !== null ? src.manualPercent : 100, saved: !!saved, fromPrev: !saved && !!src };
  });
}

/** حفظ تارجت الشهر: بيستبدل KPIs القالب بتاعة الشهر ده (الـ KPIs المخصصة بتفضل زي ما هي) */
function saveMonthlyTargets(period, rows, { vatRate = 14 } = {}) {
  const names = TARGET_TEMPLATE.map((t) => t.name);
  saveAll(STORAGE_KEYS.KPIS, getAll(STORAGE_KEYS.KPIS).filter((k) => !(k.period === period && names.includes(k.name))));
  rows.forEach((r) => {
    const t = TARGET_TEMPLATE.find((x) => x.key === r.key);
    if (!t) return;
    addKpi({
      period, name: t.name, metricType: t.metricType, category: t.category || null, weight: Number(r.weight) || 0,
      targetValue: t.metricType === 'manual_percent' ? 100 : Number(r.targetValue) || 0,
      vatRate: t.metricType === 'category_value' ? vatRate : 0, minFamilies: 4,
      manualPercent: t.metricType === 'manual_percent' ? (r.manualPercent === '' || r.manualPercent === undefined ? 100 : Number(r.manualPercent)) : null,
    });
  });
  return rows.length;
}

// ------------------------------------------------------------
// تحليل المبيعات (Sales Analysis) — المرحلة 1: KPIs + نمو + تحليل زمني + فلاتر حقيقية
// مقارنة عادلة (YTD مقابل نفس الفترة بالظبط في السنة اللي فاتت)، مبني فوق getAnalyticsLines.
// ------------------------------------------------------------

/** كل السنين اللي فيها بيانات فعلاً، تصاعدياً */
function getSalesYears(vatRate = 14) {
  const years = new Set(getAnalyticsLines(vatRate).map((l) => new Date(l.date).getFullYear()).filter((y) => !isNaN(y)));
  return [...years].sort();
}

/** آخر تاريخ فيه بيانات فعلياً لسنة معيّنة — أساس منطق YTD العادل */
function lastDataDateInYear(lines, year) {
  const inYear = lines.filter((l) => new Date(l.date).getFullYear() === year);
  if (inYear.length === 0) return null;
  return inYear.reduce((m, l) => (l.date > m ? l.date : m), inYear[0].date);
}

/**
 * بيحسب نطاق تاريخ (from/to) لفترة معيّنة من سنة، ونفس الفترة بالظبط في السنة اللي قبلها للمقارنة العادلة.
 * periodType: 'full' | 'ytd' | 'month' (months=[1..12]) | 'quarter' (quarters=[1..4]) | 'half' (halves=[1,2]) | 'custom' (from/to)
 */
function resolvePeriodRange(year, periodType, params, lines) {
  const pad = (n) => String(n).padStart(2, '0');
  let from, to, label;
  if (periodType === 'full') {
    from = `${year}-01-01`; to = `${year}-12-31`; label = `${year} (كامل السنة)`;
  } else if (periodType === 'ytd') {
    const last = lastDataDateInYear(lines, year);
    from = `${year}-01-01`; to = last ? last.slice(0, 10) : `${year}-01-01`;
    label = `${year} YTD (حتى ${to})`;
  } else if (periodType === 'month') {
    const months = (params.months && params.months.length) ? params.months : [...Array(12)].map((_, i) => i + 1);
    const minM = Math.min(...months), maxM = Math.max(...months);
    from = `${year}-${pad(minM)}-01`;
    const lastDay = new Date(year, maxM, 0).getDate();
    to = `${year}-${pad(maxM)}-${pad(lastDay)}`;
    label = months.length === 1 ? periodLabel(`${year}-${pad(minM)}`, 'month') : `${periodLabel(`${year}-${pad(minM)}`, 'month')} → ${periodLabel(`${year}-${pad(maxM)}`, 'month')}`;
  } else if (periodType === 'quarter') {
    const qs = (params.quarters && params.quarters.length) ? params.quarters : [1, 2, 3, 4];
    const minQ = Math.min(...qs), maxQ = Math.max(...qs);
    from = `${year}-${pad((minQ - 1) * 3 + 1)}-01`;
    const endMonth = maxQ * 3, lastDay = new Date(year, endMonth, 0).getDate();
    to = `${year}-${pad(endMonth)}-${pad(lastDay)}`;
    label = qs.length === 1 ? `Q${minQ} ${year}` : `Q${minQ}-Q${maxQ} ${year}`;
  } else if (periodType === 'half') {
    const hs = (params.halves && params.halves.length) ? params.halves : [1, 2];
    const minH = Math.min(...hs), maxH = Math.max(...hs);
    from = minH === 1 ? `${year}-01-01` : `${year}-07-01`;
    to = maxH === 1 ? `${year}-06-30` : `${year}-12-31`;
    label = hs.length === 1 ? `H${minH} ${year}` : `H1-H2 ${year}`;
  } else if (periodType === 'custom') {
    from = params.from || `${year}-01-01`; to = params.to || `${year}-12-31`;
    label = `${from} → ${to}`;
  } else {
    from = `${year}-01-01`; to = `${year}-12-31`; label = String(year);
  }

  // نفس الفترة بالظبط سنة قبل كده
  const shiftYear = (dateStr, delta) => { const [y, m, d] = dateStr.split('-'); return `${Number(y) + delta}-${m}-${d}`; };
  return { from, to, label, prevFrom: shiftYear(from, -1), prevTo: shiftYear(to, -1), prevYear: year - 1 };
}

function inRange(dateStr, from, to) { return dateStr >= from && dateStr <= (to.length === 10 ? to + 'T23:59:59' : to); }

function filterLines(lines, { from, to, customerIds, familyNames, productIds }) {
  return lines.filter((l) =>
    inRange(l.date, from, to) &&
    (!customerIds || !customerIds.length || customerIds.includes(l.customerId)) &&
    (!familyNames || !familyNames.length || familyNames.includes(l.family)) &&
    (!productIds || !productIds.length || productIds.includes(l.productId))
  );
}

function aggregateLines(lines) {
  const customers = new Set(), products = new Set(), families = new Set();
  let value = 0, qty = 0;
  lines.forEach((l) => { value += l.value; qty += l.qty; customers.add(l.customerId); products.add(l.productId); families.add(l.family); });
  return { value: Math.round(value * 100) / 100, qty, customers: customers.size, products: products.size, families: families.size, customerIds: customers, productIds: products };
}

/** نسبة النمو، مع التعامل مع الصفر: N/A لو السابق صفر والحالي صفر، New لو السابق صفر والحالي فيه قيمة */
function growthOf(current, previous) {
  if (previous === 0) return current === 0 ? { pct: null, label: 'N/A' } : { pct: null, label: 'جديد' };
  const pct = Math.round(((current - previous) / previous) * 10000) / 100;
  return { pct, label: `${pct >= 0 ? '+' : ''}${pct}%` };
}

/**
 * نظرة عامة شاملة لفترة معيّنة: KPIs الحالية، مقارنة عادلة بنفس الفترة في السنة اللي فاتت،
 * جودة البيانات، وملخص تنفيذي مُولّد ديناميكياً من الأرقام الفعلية.
 */
function getSalesOverview({ year, periodType = 'ytd', months = [], quarters = [], halves = [], from = null, to = null, customerIds = [], familyNames = [], productIds = [], vatRate = 14 } = {}) {
  const allLines = getAnalyticsLines(vatRate);
  const range = resolvePeriodRange(year, periodType, { months, quarters, halves, from, to }, allLines);

  const curLines = filterLines(allLines, { from: range.from, to: range.to, customerIds, familyNames, productIds });
  const prevLines = filterLines(allLines, { from: range.prevFrom, to: range.prevTo, customerIds, familyNames, productIds });

  const cur = aggregateLines(curLines);
  const prev = aggregateLines(prevLines);

  const avgPerCustomer = cur.customers > 0 ? Math.round((cur.value / cur.customers) * 100) / 100 : 0;

  // تصنيف العملاء: جديد / فقدناه / مستمر (بالنسبة لنطاق الفلتر الحالي، بغض النظر عن فترة الفلتر الزمنية)
  const curCustSet = cur.customerIds, prevCustSet = prev.customerIds;
  const newCustomers = [...curCustSet].filter((id) => !prevCustSet.has(id));
  const lostCustomers = [...prevCustSet].filter((id) => !curCustSet.has(id));
  const existingCustomers = [...curCustSet].filter((id) => prevCustSet.has(id));

  // أكبر نمو/تراجع لإدراجه في الملخص التنفيذي
  const custGrowth = aggregateBy(curLines, (l) => l.customerId, 'customer').map((c) => {
    const prevVal = prevLines.filter((l) => l.customerId === c.key).reduce((s, l) => s + l.value, 0);
    return { ...c, g: growthOf(c.value, prevVal) };
  }).filter((c) => c.g.pct !== null).sort((a, b) => b.g.pct - a.g.pct);
  const famGrowth = aggregateBy(curLines, (l) => l.family, 'family').map((f) => {
    const prevVal = prevLines.filter((l) => l.family === f.key).reduce((s, l) => s + l.value, 0);
    return { ...f, g: growthOf(f.value, prevVal) };
  }).filter((f) => f.g.pct !== null).sort((a, b) => b.g.pct - a.g.pct);

  const valueGrowth = growthOf(cur.value, prev.value);
  const qtyGrowth = growthOf(cur.qty, prev.qty);
  const customersGrowth = growthOf(cur.customers, prev.customers);

  // ملخص تنفيذي ديناميكي
  const summary = [];
  if (valueGrowth.pct !== null) summary.push(`المبيعات ${valueGrowth.pct >= 0 ? 'زادت' : 'قلّت'} بنسبة ${Math.abs(valueGrowth.pct)}% عن ${range.prevYear} (نفس الفترة).`);
  if (qtyGrowth.pct !== null) summary.push(`الكمية ${qtyGrowth.pct >= 0 ? 'زادت' : 'قلّت'} بنسبة ${Math.abs(qtyGrowth.pct)}%.`);
  if (customersGrowth.pct !== null) summary.push(`عدد العملاء النشطين ${customersGrowth.pct >= 0 ? 'زاد' : 'قلّ'} بنسبة ${Math.abs(customersGrowth.pct)}%.`);
  if (famGrowth.length) summary.push(`أعلى فاميلي نمواً: ${famGrowth[0].name} (${famGrowth[0].g.label}).`);
  if (custGrowth.length) summary.push(`أعلى عميل نمواً: ${custGrowth[0].name} (${custGrowth[0].g.label}).`);
  if (newCustomers.length) summary.push(`${newCustomers.length} عميل جديد اشترى في الفترة دي ومكانش بيشتري في نفس الفترة السنة اللي فاتت.`);
  if (lostCustomers.length) summary.push(`${lostCustomers.length} عميل كان نشط السنة اللي فاتت وتوقف في نفس الفترة دي.`);

  // جودة البيانات
  const totalRecords = curLines.length;
  const missingFamily = curLines.filter((l) => l.family === 'بدون تصنيف').length;
  const missingProduct = curLines.filter((l) => l.productName === '(منتج محذوف)').length;

  return {
    range,
    current: { ...cur, avgPerCustomer },
    previous: prev,
    growth: { value: valueGrowth, qty: qtyGrowth, customers: customersGrowth },
    customerClassification: { new: newCustomers.length, lost: lostCustomers.length, existing: existingCustomers.length },
    topGrowth: { customers: custGrowth.slice(0, 5), families: famGrowth.slice(0, 5) },
    topDecline: { customers: custGrowth.slice(-5).reverse(), families: famGrowth.slice(-5).reverse() },
    summary,
    dataQuality: { totalRecords, missingFamily, missingProduct },
  };
}

// ------------------------------------------------------------
// تحليل المبيعات — المرحلة 2: جداول العملاء/الفاميلي/المنتج بالتفصيل + Ranking
// ------------------------------------------------------------

function periodRangeOnly(year, periodType, params, lines) { return resolvePeriodRange(year, periodType, params, lines); }

/** صفوف تحليل كل عميل (حتى لو مالوش بيع في الفترة الحالية، عشان العملاء المفقودين يظهروا) */
function getCustomerAnalysisRows({ year, periodType = 'ytd', months = [], quarters = [], halves = [], familyNames = [], productIds = [], vatRate = 14 } = {}) {
  const allLines = getAnalyticsLines(vatRate);
  const range = periodRangeOnly(year, periodType, { months, quarters, halves }, allLines);
  const curLines = filterLines(allLines, { from: range.from, to: range.to, familyNames, productIds });
  const prevLines = filterLines(allLines, { from: range.prevFrom, to: range.prevTo, familyNames, productIds });
  const curAgg = aggregateBy(curLines, (l) => l.customerId, 'customer');
  const prevAgg = aggregateBy(prevLines, (l) => l.customerId, 'customer');
  const prevMap = new Map(prevAgg.map((c) => [c.key, c]));
  const curMap = new Map(curAgg.map((c) => [c.key, c]));
  const allIds = new Set([...curMap.keys(), ...prevMap.keys()]);
  const customers = getAll(STORAGE_KEYS.CUSTOMERS);
  const cMap = new Map(customers.map((c) => [c.id, c]));
  return [...allIds].map((id) => {
    const cur = curMap.get(id) || { value: 0, qty: 0 };
    const prev = prevMap.get(id) || { value: 0, qty: 0 };
    const customer = cMap.get(id);
    const status = cur.value > 0 && prev.value > 0 ? 'مستمر' : cur.value > 0 ? 'جديد' : 'فقدناه';
    return {
      customerId: id, name: customer ? customer.name : '(محذوف)', code: customer ? customer.code || '' : '',
      curValue: cur.value, prevValue: prev.value, curQty: cur.qty, prevQty: prev.qty,
      valueGrowth: growthOf(cur.value, prev.value), qtyGrowth: growthOf(cur.qty, prev.qty), status,
    };
  });
}

/** صفوف تحليل كل فاميلي، شاملة عدد العملاء وعدد المنتجات داخل كل فاميلي في الفترة الحالية */
function getFamilyAnalysisRows({ year, periodType = 'ytd', months = [], quarters = [], halves = [], customerIds = [], vatRate = 14 } = {}) {
  const allLines = getAnalyticsLines(vatRate);
  const range = periodRangeOnly(year, periodType, { months, quarters, halves }, allLines);
  const curLines = filterLines(allLines, { from: range.from, to: range.to, customerIds });
  const prevLines = filterLines(allLines, { from: range.prevFrom, to: range.prevTo, customerIds });
  const curAgg = aggregateBy(curLines, (l) => l.family, 'family');
  const prevMap = new Map(aggregateBy(prevLines, (l) => l.family, 'family').map((f) => [f.key, f]));
  const curMap = new Map(curAgg.map((f) => [f.key, f]));
  const allFams = new Set([...curMap.keys(), ...prevMap.keys()]);
  return [...allFams].map((fam) => {
    const cur = curMap.get(fam) || { value: 0, qty: 0 };
    const prev = prevMap.get(fam) || { value: 0, qty: 0 };
    const custCount = new Set(curLines.filter((l) => l.family === fam).map((l) => l.customerId)).size;
    const prodCount = new Set(curLines.filter((l) => l.family === fam).map((l) => l.productId)).size;
    return {
      family: fam, curValue: cur.value, prevValue: prev.value, curQty: cur.qty, prevQty: prev.qty,
      valueGrowth: growthOf(cur.value, prev.value), qtyGrowth: growthOf(cur.qty, prev.qty),
      customerCount: custCount, productCount: prodCount,
    };
  });
}

/** صفوف تحليل كل منتج، مع ملاحظة (جديد / توقف بيعه / صفر مبيعات) */
function getProductAnalysisRows({ year, periodType = 'ytd', months = [], quarters = [], halves = [], customerIds = [], familyNames = [], vatRate = 14 } = {}) {
  const allLines = getAnalyticsLines(vatRate);
  const range = periodRangeOnly(year, periodType, { months, quarters, halves }, allLines);
  const curLines = filterLines(allLines, { from: range.from, to: range.to, customerIds, familyNames });
  const prevLines = filterLines(allLines, { from: range.prevFrom, to: range.prevTo, customerIds, familyNames });
  const curAgg = aggregateBy(curLines, (l) => l.productId, 'product');
  const prevAgg = aggregateBy(prevLines, (l) => l.productId, 'product');
  const prevMap = new Map(prevAgg.map((p) => [p.key, p]));
  const curMap = new Map(curAgg.map((p) => [p.key, p]));
  const famOf = new Map([...curLines, ...prevLines].map((l) => [l.productId, l.family]));
  const allIds = new Set([...curMap.keys(), ...prevMap.keys()]);
  return [...allIds].map((id) => {
    const cur = curMap.get(id) || { value: 0, qty: 0, name: null };
    const prev = prevMap.get(id) || { value: 0, qty: 0, name: null };
    const note = cur.value > 0 && prev.value === 0 ? 'جديد' : cur.value === 0 && prev.value > 0 ? 'توقف بيعه' : cur.value === 0 && prev.value === 0 ? 'صفر مبيعات' : '';
    return {
      productId: id, name: cur.name || prev.name || '?', family: famOf.get(id) || 'بدون تصنيف',
      curValue: cur.value, prevValue: prev.value, curQty: cur.qty, prevQty: prev.qty,
      valueGrowth: growthOf(cur.value, prev.value), qtyGrowth: growthOf(cur.qty, prev.qty), note,
    };
  });
}

// ------------------------------------------------------------
// تحليل المبيعات — المرحلة 3: Customer × Family Matrix + Drill Down
// ------------------------------------------------------------

/** مصفوفة عميل × فاميلي: لكل عميل عنده بيع في الفترة، قيمة/كمية/نمو كل فاميلي */
function getCustomerFamilyMatrix({ year, periodType = 'ytd', months = [], quarters = [], halves = [], vatRate = 14 } = {}) {
  const allLines = getAnalyticsLines(vatRate);
  const range = periodRangeOnly(year, periodType, { months, quarters, halves }, allLines);
  const curLines = filterLines(allLines, { from: range.from, to: range.to });
  const prevLines = filterLines(allLines, { from: range.prevFrom, to: range.prevTo });
  const families = getFamilies();
  const customers = getAll(STORAGE_KEYS.CUSTOMERS);

  function buildMap(lines) {
    const map = new Map();
    lines.forEach((l) => {
      if (!map.has(l.customerId)) map.set(l.customerId, new Map());
      const fm = map.get(l.customerId);
      if (!fm.has(l.family)) fm.set(l.family, { value: 0, qty: 0 });
      const c = fm.get(l.family);
      c.value += l.value; c.qty += l.qty;
    });
    return map;
  }
  const curMap = buildMap(curLines), prevMap = buildMap(prevLines);

  const rows = [...curMap.keys()].map((cid) => {
    const customer = customers.find((c) => c.id === cid);
    const cells = {};
    families.forEach((fam) => {
      const cur = curMap.get(cid)?.get(fam) || { value: 0, qty: 0 };
      const prev = prevMap.get(cid)?.get(fam) || { value: 0, qty: 0 };
      cells[fam] = { curValue: Math.round(cur.value * 100) / 100, curQty: cur.qty, prevValue: Math.round(prev.value * 100) / 100, prevQty: prev.qty, growth: growthOf(cur.value, prev.value) };
    });
    const totalValue = families.reduce((s, f) => s + cells[f].curValue, 0);
    return { customerId: cid, name: customer ? customer.name : '(محذوف)', cells, totalValue: Math.round(totalValue * 100) / 100 };
  }).sort((a, b) => b.totalValue - a.totalValue);

  return { families, rows };
}

/** كل سطور المبيعات المفلترة بالفترة والفلاتر الحالية — أساس جدول البيانات التفصيلي والتصدير */
function getDetailedSalesLines({ year, periodType = 'ytd', months = [], quarters = [], halves = [], customerIds = [], familyNames = [], productIds = [], vatRate = 14 } = {}) {
  const allLines = getAnalyticsLines(vatRate);
  const range = periodRangeOnly(year, periodType, { months, quarters, halves }, allLines);
  return filterLines(allLines, { from: range.from, to: range.to, customerIds, familyNames, productIds })
    .map((l) => ({ ...l, value: Math.round(l.value * 100) / 100 }));
}

/** جدول مقارنة شهر-بشهر بين سنتين لنفس الفلاتر (للرسم البياني والجدول الزمني) */
function getSalesTimeBreakdown({ year, granularity = 'month', customerIds = [], familyNames = [], productIds = [], vatRate = 14 } = {}) {
  const allLines = getAnalyticsLines(vatRate);
  const filtered = allLines.filter((l) =>
    (!customerIds || !customerIds.length || customerIds.includes(l.customerId)) &&
    (!familyNames || !familyNames.length || familyNames.includes(l.family)) &&
    (!productIds || !productIds.length || productIds.includes(l.productId))
  );
  const buckets = granularity === 'quarter' ? 4 : granularity === 'half' ? 2 : 12;
  const keyFor = (l) => {
    const d = new Date(l.date);
    if (granularity === 'month') return d.getMonth() + 1;
    if (granularity === 'quarter') return Math.ceil((d.getMonth() + 1) / 3);
    return d.getMonth() < 6 ? 1 : 2;
  };
  const rows = [];
  for (let b = 1; b <= buckets; b++) {
    const curB = filtered.filter((l) => new Date(l.date).getFullYear() === year && keyFor(l) === b);
    const prevB = filtered.filter((l) => new Date(l.date).getFullYear() === year - 1 && keyFor(l) === b);
    const cur = aggregateLines(curB), prev = aggregateLines(prevB);
    const label = granularity === 'month' ? periodLabel(`${year}-${String(b).padStart(2, '0')}`, 'month').split(' ')[0] : granularity === 'quarter' ? `Q${b}` : `H${b}`;
    rows.push({ bucket: b, label, curValue: cur.value, prevValue: prev.value, curQty: cur.qty, prevQty: prev.qty, growth: growthOf(cur.value, prev.value) });
  }
  return rows;
}

/** كل الفترات اللي فيها بيانات فعلاً لدقة معيّنة، الأحدث أولاً — لتعبئة قايمة اختيار الفترة */
function getAvailablePeriods(granularity, vatRate = 14) {
  if (granularity === 'all') return [];
  const lines = getAnalyticsLines(vatRate);
  const keys = new Set(lines.map((l) => periodKey(l.date, granularity)).filter(Boolean));
  return [...keys].sort().reverse().map((k) => ({ key: k, label: periodLabel(k, granularity) }));
}

function matchesLevel(line, level, levelValue) {
  if (level === 'family') return line.family === levelValue;
  if (level === 'product') return line.productId === levelValue;
  if (level === 'customer') return line.customerId === levelValue;
  return true; // overview
}

/**
 * التحليل الكامل لمستوى معيّن (فاميلي/منتج/عميل/نظرة عامة) ودقة زمنية ومفتاح فترة.
 * بيرجّع: القيمة والكمية وعدد العملاء النشطين للفترة، اتجاه كل الفترات المتاحة،
 * مقارنة بنفس الفترة السنة اللي فاتت، وتفصيل (breakdown) مختلف حسب المستوى.
 */
function getAnalytics({ level = 'overview', levelValue = null, granularity = 'month', periodKey: pKey = null, vatRate = 14 } = {}) {
  const lines = getAnalyticsLines(vatRate).filter((l) => matchesLevel(l, level, levelValue));

  // كل الفترات المتاحة في البيانات لهذا المستوى، للرسم البياني
  const byPeriod = new Map();
  lines.forEach((l) => {
    const k = granularity === 'all' ? 'all' : periodKey(l.date, granularity);
    if (!k) return;
    if (!byPeriod.has(k)) byPeriod.set(k, { value: 0, qty: 0, customers: new Set() });
    const agg = byPeriod.get(k);
    agg.value += l.value;
    agg.qty += l.qty;
    agg.customers.add(l.customerId);
  });
  const trend = [...byPeriod.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, agg]) => ({ key, label: periodLabel(key, granularity), value: Math.round(agg.value * 100) / 100, qty: agg.qty, activeDealers: agg.customers.size }));

  const currentKey = granularity === 'all' ? 'all' : (pKey || trend.at(-1)?.key || null);
  const current = byPeriod.get(currentKey) || { value: 0, qty: 0, customers: new Set() };
  const prevKey = granularity === 'all' ? null : shiftPeriodKeyYears(currentKey, granularity, 1);
  const previous = prevKey ? byPeriod.get(prevKey) : null;
  const comparison = {
    currentKey, currentLabel: periodLabel(currentKey, granularity),
    previousKey: prevKey, previousLabel: prevKey ? periodLabel(prevKey, granularity) : null,
    currentValue: Math.round(current.value * 100) / 100,
    previousValue: previous ? Math.round(previous.value * 100) / 100 : null,
    deltaPct: previous && previous.value > 0 ? Math.round(((current.value - previous.value) / previous.value) * 10000) / 100 : null,
  };

  const currentLines = granularity === 'all' ? lines : lines.filter((l) => periodKey(l.date, granularity) === currentKey);

  // تفصيل مختلف حسب المستوى
  let breakdown = [];
  if (level === 'overview') {
    breakdown = aggregateBy(currentLines, (l) => l.family, 'family').slice(0, 10);
  } else if (level === 'family') {
    breakdown = aggregateBy(currentLines, (l) => l.productId, 'product').slice(0, 20);
  } else if (level === 'product') {
    breakdown = aggregateBy(currentLines, (l) => l.customerId, 'customer').slice(0, 20);
  } else if (level === 'customer') {
    const byFam = aggregateBy(currentLines, (l) => l.family, 'family');
    breakdown = byFam;
  }

  let topCustomers = [];
  if (level === 'overview') topCustomers = aggregateBy(currentLines, (l) => l.customerId, 'customer').slice(0, 10);

  return {
    level, levelValue, granularity,
    value: Math.round(current.value * 100) / 100,
    qty: current.qty,
    activeDealers: current.customers.size,
    trend, comparison, breakdown, topCustomers,
  };
}

function aggregateBy(lines, keyFn, kind) {
  const map = new Map();
  lines.forEach((l) => {
    const k = keyFn(l);
    if (k === null || k === undefined) return;
    if (!map.has(k)) {
      map.set(k, {
        key: k,
        name: kind === 'family' ? k : kind === 'product' ? l.productName : kind === 'customer' ? l.customerName : k,
        value: 0, qty: 0, families: new Set(),
      });
    }
    const agg = map.get(k);
    agg.value += l.value;
    agg.qty += l.qty;
    agg.families.add(l.family);
  });
  return [...map.values()]
    .map((a) => ({ key: a.key, name: a.name, value: Math.round(a.value * 100) / 100, qty: a.qty, familyCount: a.families.size }))
    .sort((a, b) => b.value - a.value);
}

/**
 * تنبيهات ذكية: عملاء صاعدين/هابطين بشكل ملحوظ (مقارنة بنفس الفترة السنة اللي فاتت)،
 * وفاميلي ضعيفة (نازلة عن نفس الفترة السنة اللي فاتت). العتبة الافتراضية 25%.
 */
function getSmartAlerts({ granularity = 'month', periodKey: pKey = null, vatRate = 14, threshold = 25 } = {}) {
  const lines = getAnalyticsLines(vatRate);
  const currentKey = granularity === 'all' ? null : (pKey || [...new Set(lines.map((l) => periodKey(l.date, granularity)))].sort().at(-1));
  if (!currentKey) return { risingCustomers: [], fallingCustomers: [], weakFamilies: [] };
  const prevKey = shiftPeriodKeyYears(currentKey, granularity, 1);

  const curLines = lines.filter((l) => periodKey(l.date, granularity) === currentKey);
  const prevLines = lines.filter((l) => periodKey(l.date, granularity) === prevKey);

  function deltaList(keyFn, nameFn) {
    const cur = new Map(), prev = new Map();
    curLines.forEach((l) => cur.set(keyFn(l), (cur.get(keyFn(l)) || 0) + l.value));
    prevLines.forEach((l) => prev.set(keyFn(l), (prev.get(keyFn(l)) || 0) + l.value));
    const keys = new Set([...cur.keys(), ...prev.keys()]);
    const out = [];
    keys.forEach((k) => {
      const c = cur.get(k) || 0, p = prev.get(k) || 0;
      if (p < 100) return; // تجاهل اللي مالوش حجم يُذكر السنة اللي فاتت (نسبة % بتبقى مضللة)
      const pct = Math.round(((c - p) / p) * 10000) / 100;
      out.push({ key: k, name: nameFn(k), current: Math.round(c), previous: Math.round(p), deltaPct: pct });
    });
    return out;
  }

  const custDeltas = deltaList((l) => l.customerId, (id) => (lines.find((l) => l.customerId === id) || {}).customerName || '?');
  const famDeltas = deltaList((l) => l.family, (f) => f);

  return {
    periodKey: currentKey, previousKey: prevKey,
    risingCustomers: custDeltas.filter((d) => d.deltaPct >= threshold).sort((a, b) => b.deltaPct - a.deltaPct).slice(0, 10),
    fallingCustomers: custDeltas.filter((d) => d.deltaPct <= -threshold).sort((a, b) => a.deltaPct - b.deltaPct).slice(0, 10),
    weakFamilies: famDeltas.filter((d) => d.deltaPct <= -threshold).sort((a, b) => a.deltaPct - b.deltaPct),
  };
}

/**
 * White Space: العملاء اللي اشتروا من كذا فاميلي أو أكتر (kpi.minFamilies، أقل حد 4) في الفترة.
 * بيرجّع تفاصيل كل عميل (الاسم وعدد الفاميلي) مش رقم بس، عشان تقدر تشوف الأسماء تحت الـ KPI.
 */
function getWhiteSpaceDetail(kpi) {
  const groups = getWhiteSpaceGroups();
  const min = Math.max(kpi.minFamilies || 4, 4);
  const byCustomer = new Map();
  getDeliveredLines().filter((l) => inPeriod(l.date, kpi.period)).forEach((l) => {
    groups.forEach((g) => {
      if (g.tags.some((t) => hasCat(l.category, t))) {
        if (!byCustomer.has(l.customerId)) byCustomer.set(l.customerId, new Set());
        byCustomer.get(l.customerId).add(g.name);
      }
    });
  });
  const customers = getAll(STORAGE_KEYS.CUSTOMERS);
  return [...byCustomer.entries()]
    .filter(([, fams]) => fams.size >= min)
    .map(([customerId, fams]) => ({ customerId, name: customers.find((c) => c.id === customerId)?.name || '(محذوف)', familyCount: fams.size, families: [...fams] }))
    .sort((a, b) => b.familyCount - a.familyCount);
}

function computeKpiAchieved(kpi) {
  if (kpi.metricType === 'manual_percent') return kpi.manualPercent === undefined || kpi.manualPercent === null ? 100 : Number(kpi.manualPercent);
  const lines = getDeliveredLines().filter((l) => inPeriod(l.date, kpi.period));
  const rets = getDeliveredReturns().filter((r) => inPeriod(r.date, kpi.period));
  if (kpi.metricType === 'active_dealers') return new Set(lines.map((l) => l.customerId)).size;
  if (kpi.metricType === 'white_space_dealers') return getWhiteSpaceDetail(kpi).length;

  const scoped = (x) => !kpi.category || kpi.metricType === 'total_value' || hasCat(x.category, kpi.category);
  const sumValue = (arr) => arr.filter(scoped).reduce((s, x) => s + x.value, 0);
  const sumQty = (arr) => arr.filter(scoped).reduce((s, x) => s + x.qty, 0);
  const vatDiv = 1 + (kpi.vatRate || 0) / 100;
  const deduction = 1 - (kpi.deductionPercent || 0) / 100;

  if (kpi.metricType === 'total_value' || kpi.metricType === 'category_value') return ((sumValue(lines) - sumValue(rets)) / vatDiv) * deduction;
  if (kpi.metricType === 'category_count') return sumQty(lines) - sumQty(rets);
  return 0;
}

function getKpiProgress(kpiId) {
  const kpi = getAll(STORAGE_KEYS.KPIS).find((k) => k.id === kpiId);
  if (!kpi) return null;
  const achieved = computeKpiAchieved(kpi);
  const percentage = kpi.targetValue > 0 ? (achieved / kpi.targetValue) * 100 : 0;
  const scoredPct = getTargetCap() ? Math.min(percentage, 100) : percentage; // السكور بيتحسب على الإنجاز بعد الحد الأقصى (لو مفعّل)
  const weightedScore = (scoredPct / 100) * kpi.weight;
  const whiteSpaceCustomers = kpi.metricType === 'white_space_dealers' ? getWhiteSpaceDetail(kpi) : null;
  return { ...kpi, achieved, percentage: Math.round(percentage * 100) / 100, weightedScore: Math.round(weightedScore * 100) / 100, whiteSpaceCustomers };
}

/** كل KPIs شهر معيّن + الدرجة الكلية المرجّحة (مجموع كل KPI × نسبة وزنه) */
function getMonthlyScorecard(period) {
  const kpis = getAll(STORAGE_KEYS.KPIS).filter((k) => k.period === period).map((k) => getKpiProgress(k.id));
  const overallScore = Math.round(kpis.reduce((sum, k) => sum + k.weightedScore, 0) * 100) / 100;
  const totalWeight = kpis.reduce((sum, k) => sum + k.weight, 0);
  return { period, kpis, overallScore, totalWeight };
}

// ------------------------------------------------------------
// النسخ الاحتياطي والاستيراد (Backup / Restore) - إجباري
// ------------------------------------------------------------

function exportAllData() {
  const dump = {};
  Object.values(STORAGE_KEYS).forEach((key) => {
    dump[key] = getAll(key);
  });
  dump.exportedAt = new Date().toISOString();
  return dump;
}

function downloadBackup() {
  const data = exportAllData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `erp-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  localStorage.setItem('erp_last_backup_at', new Date().toISOString());
}

/** كام يوم فات من آخر نسخة احتياطية (null لو لسه معملتش نسخة خالص) */
function getDaysSinceLastBackup() {
  const last = localStorage.getItem('erp_last_backup_at');
  if (!last) return null;
  return Math.floor((Date.now() - new Date(last).getTime()) / (1000 * 60 * 60 * 24));
}

function importBackup(jsonData) {
  const known = jsonData && typeof jsonData === 'object' ? Object.keys(jsonData).filter((k) => Object.values(STORAGE_KEYS).includes(k)) : [];
  if (known.length === 0) throw new Error('invalid backup');
  if (typeof confirm === 'function' && !confirm('⚠ الاستعادة هتستبدل الجداول الموجودة في الملف ده بس (اللي مش موجود في الملف هيفضل زي ما هو). هنعمل نسخة احتياطية من وضعك الحالي أول قبل ما نبدأ، احتياطاً. متأكد إنك عايز تكمل؟')) return false;
  downloadBackup(); // نسخة أمان تلقائية من الوضع الحالي قبل الاستبدال
  Object.entries(jsonData).forEach(([key, value]) => {
    if (Object.values(STORAGE_KEYS).includes(key)) {
      saveAll(key, value);
    }
  });
  return true;
}

// ------------------------------------------------------------
// التصدير (Exports)
// ------------------------------------------------------------

export {
  STORAGE_KEYS,
  initStorage,
  // عام
  getAll, addRecord, updateRecord, deleteRecord,
  // عملاء
  addCustomer, getCustomerBalance, getAllCustomerBalances, getCustomerStatement, getCustomerCashCreditMix,
  getOverCreditLimitCustomers, getCustomerAging, getAgingReport,
  getTopCustomers, getTopProducts,
  // مندوبين
  addRep, importCustomers, importProducts,
  // منتجات ومخزون
  addProduct, getProductStock, getStockMap, addInventoryTransaction, getLowStockAlerts, isProductUsed,
  setProductOffer, clearProductOffer, getEffectivePrice,
  addStockStatusUpdate, importStockStatus, getLatestStockStatus, getStockStatusHistory,
  importDealerStock, getDealerStock, getDealerStockHistory, getDealersStockOverview,
  // عمليات مركّبة
  recordSale, recordReceipt,
  // حالات الطلبية والأصناف
  ORDER_STATUSES, updateOrderStatus, updateOrderItemStatus,
  // رقم الطلبية والتجديد + إقفال الشهر
  updateOrderNumber, getRenewalDaysLeft, getOrdersNeedingRenewal,
  updateOrderItems, voidOrder,
  recordReturn, getOrderReturns,
  getOrderAuditLog,
  getActiveOrders, getReportOrders, startNewMonth, esc, inPeriod, importHistoricalOrders,
  importLedgerAdjustments, importOpeningBalances, getReconciliationReport, getCustomerBalanceAsOf,
  // شيكات
  updateCheckDelivery, markCheckCleared, markCheckBounced, getChecksDueSoon,
  // أهداف
  setTarget, getTargetProgress,
  // التارجت الشهري (KPIs)
  addKpi, getKpiProgress, getMonthlyScorecard, productFamily,
  getFamilies, getAnalytics, getSmartAlerts, getAvailablePeriods,
  isProductHidden, getActiveProducts, syncCatalogToList,
  getSetting, setSetting, getWhiteSpaceGroups, setWhiteSpaceGroups, getTargetCap, setTargetCap, getDeliveredLines, getKpiDetails, getPeriodTotalValue, TARGET_TEMPLATE, getMonthlyTargetsForm, saveMonthlyTargets, setOrderItemDeliveredAt,
  DIVISIONS, productDivision, productPath, productSubPath, isClassified, setProductClassification, importClassification, getCategoryTree, applyAutoClassification, archiveOrDeleteCatalog,
  getSalesYears, getSalesOverview, getSalesTimeBreakdown, clearHistoricalImports,
  getCustomerAnalysisRows, getFamilyAnalysisRows, getProductAnalysisRows, getCustomerFamilyMatrix, getDetailedSalesLines,
  // نسخ احتياطي
  exportAllData, downloadBackup, importBackup, getDaysSinceLastBackup,
};
