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
    return false;
  }
}

function addRecord(key, record) {
  const all = getAll(key);
  const newRecord = { id: generateId(), createdAt: new Date().toISOString(), ...record };
  all.push(newRecord);
  saveAll(key, all);
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
  all[idx] = { ...all[idx], ...changes, updatedAt: new Date().toISOString() };
  saveAll(key, all);
  return all[idx];
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

function addCustomer({ name, category = 'عام', openingBalance = 0, creditLimit = 0, phone = '', discountRate = 0 }) {
  return addRecord(STORAGE_KEYS.CUSTOMERS, { name, category, openingBalance, creditLimit, phone, discountRate });
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

  const totalReturns = getAll(STORAGE_KEYS.RETURNS)
    .filter((r) => r.customerId === customerId)
    .reduce((sum, r) => sum + r.totalValue, 0);

  return customer.openingBalance + totalSales - totalReceipts - totalReturns;
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
      date: o.createdAt,
      type: `فاتورة بيع #${o.invoiceNo || '-'} (${o.cashDiscount ? 'نقدي' : 'آجل'})`,
      debit: o.total, credit: 0, ref: o.id,
    }));

  const returns = getAll(STORAGE_KEYS.RETURNS)
    .filter((r) => r.customerId === customerId)
    .map((r) => ({ date: r.createdAt, type: 'مرتجع', debit: 0, credit: r.totalValue, ref: r.id }));

  const receipts = getAll(STORAGE_KEYS.RECEIPTS)
    .filter((r) => r.customerId === customerId)
    .map((r) => {
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
      return {
        date: r.createdAt,
        type,
        debit: r.voided ? r.amount : 0, // الشيك المرتد يرجع كمديونية (مدين) في كشف الحساب
        credit: r.voided ? 0 : r.amount,
        ref: r.id,
      };
    });

  const movements = [...sales, ...returns, ...receipts].sort((a, b) => new Date(a.date) - new Date(b.date));

  const openingRow = {
    date: customer ? customer.createdAt : new Date(0).toISOString(),
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
 * ملخص سريع لموقف العميل: عدد وقيمة فواتيره النقدي مقابل الآجل،
 * عشان تفهم بسهولة هل هو عميل "مكس" (بيدفع كاش أحياناً وآجل أحياناً)
 */
function getCustomerCashCreditMix(customerId) {
  const orders = getAll(STORAGE_KEYS.SALES_ORDERS).filter((o) => o.customerId === customerId && !o.voided);
  const cash = orders.filter((o) => o.cashDiscount);
  const credit = orders.filter((o) => !o.cashDiscount);
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
    debits.push({ date: customer.createdAt, amount: customer.openingBalance, remaining: customer.openingBalance, label: 'رصيد افتتاحي' });
  }
  getAll(STORAGE_KEYS.SALES_ORDERS)
    .filter((o) => o.customerId === customerId && !o.voided)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .forEach((o) => debits.push({ date: o.date, amount: o.total, remaining: o.total, label: 'فاتورة بيع', ref: o.id }));

  debits.sort((a, b) => new Date(a.date) - new Date(b.date));

  const credits = [
    ...getAll(STORAGE_KEYS.RECEIPTS).filter((r) => r.customerId === customerId && !r.voided).map((r) => ({ date: r.date, amount: r.amount })),
    ...getAll(STORAGE_KEYS.RETURNS).filter((r) => r.customerId === customerId).map((r) => ({ date: r.date, amount: r.totalValue })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));

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
  const orders = getActiveOrders().filter((o) => !period || o.date.startsWith(period));
  const customers = getAll(STORAGE_KEYS.CUSTOMERS);
  const totals = {};
  orders.forEach((o) => { totals[o.customerId] = (totals[o.customerId] || 0) + o.total; });

  // اطرح قيمة المرتجعات المسجّلة في نفس الفترة (صافي مبيعات حقيقي)
  getAll(STORAGE_KEYS.RETURNS)
    .filter((r) => !period || r.date.startsWith(period))
    .forEach((r) => { totals[r.customerId] = (totals[r.customerId] || 0) - r.totalValue; });

  return Object.entries(totals)
    .map(([customerId, total]) => ({ customer: customers.find((c) => c.id === customerId), total }))
    .filter((r) => r.customer)
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

/** أكتر المنتجات مبيعاً (بالكمية والقيمة، صافي بعد خصم المرتجعات)، اختيارياً لفترة معيّنة */
function getTopProducts(period = null, limit = 5) {
  const orders = getActiveOrders().filter((o) => !period || o.date.startsWith(period));
  const products = getAll(STORAGE_KEYS.PRODUCTS);
  const totals = {};
  orders.forEach((o) => o.items.forEach((it) => {
    if (!totals[it.productId]) totals[it.productId] = { qty: 0, value: 0 };
    totals[it.productId].qty += it.qty;
    totals[it.productId].value += it.qty * it.unitPrice;
  }));

  getAll(STORAGE_KEYS.RETURNS)
    .filter((r) => !period || r.date.startsWith(period))
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

/** الكمية الحالية = مجموع حركات "وارد" - مجموع حركات "صادر" */
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
  return getAll(STORAGE_KEYS.PRODUCTS)
    .map((p) => ({ ...p, currentStock: getProductStock(p.id) }))
    .filter((p) => p.currentStock <= p.reorderLevel);
}

/**
 * ATP والكمية الجاية (Incoming) أرقام بتوصلك جاهزة من مصدر خارجي
 * (المصنع / المخزن المركزي) وبتتحدّث كتير على مدار الشهر.
 * بنسجلها كـ "سجل تاريخي" (Log) مش كرقم ثابت بيتم الكتابة فوقه،
 * عشان تقدر ترجع تشوف امتى اتغيّرت والقيمة القديمة قبل التحديث.
 */
function addStockStatusUpdate({ productId, atp = null, incoming = null, note = '' }) {
  return addRecord(STORAGE_KEYS.STOCK_STATUS, { productId, atp, incoming, note, date: new Date().toISOString() });
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
// عمليات مركّبة: فاتورة بيع (تؤثر على المخزون + حساب العميل معاً)
// ------------------------------------------------------------

/**
 * items: [{ productId, qty, unitPrice }]
 * cashDiscount: هل الفاتورة دي كاش قبل الاستلام؟ لو true، بيتطبق
 * خصم العميل الثابت (customer.discountRate) على الإجمالي، وبيتسجل
 * بشفافية (subtotal / discountRate / discountAmount / total) عشان
 * تقدر ترجع تتأكد إزاي وصلنا للرقم النهائي.
 * ملاحظة: سعر العرض (لو موجود على المنتج) بيتطبق دايماً بغض النظر
 * عن كاش الفاتورة - العميل بياخد خصمه فوق سعر العرض مش بدل منه.
 */
function recordSale({ customerId, items, repId = null, cashDiscount = false, date = new Date().toISOString() }) {
  const subtotal = items.reduce((sum, i) => sum + i.qty * i.unitPrice, 0);

  let discountRate = 0;
  if (cashDiscount) {
    const customer = getAll(STORAGE_KEYS.CUSTOMERS).find((c) => c.id === customerId);
    discountRate = customer?.discountRate || 0;
  }
  const discountAmount = subtotal * (discountRate / 100);
  const total = subtotal - discountAmount;

  // كل صنف بياخد حالته الخاصة + سعر اللستة وقت البيع (عشان لو كان فيه عرض،
  // نسخة العميل تقدر توضح "كان X، عرض Y" حتى لو العرض اتشال بعدين)
  const products = getAll(STORAGE_KEYS.PRODUCTS);
  const itemsWithStatus = items.map((i) => {
    const product = products.find((p) => p.id === i.productId);
    return { ...i, status: i.status || 'unconfirmed', listPriceAtSale: product ? product.basePrice : i.unitPrice };
  });

  const invoiceNo = getAll(STORAGE_KEYS.SALES_ORDERS).length + 1;

  const order = addRecord(STORAGE_KEYS.SALES_ORDERS, {
    customerId, repId, items: itemsWithStatus, subtotal, cashDiscount, discountRate, discountAmount, total, date,
    invoiceNo,                     // رقم فاتورة داخلي تسلسلي بسيط (#1, #2, ...)
    orderNumber: null,             // رقم الطلبية على الساب - بيتدخل يدوي بعدين
    sentByEmail: false,            // تشك بسيط: اتبعتت الطلبية بالإيميل ولا لأ
    orderNumberUpdatedAt: date,    // بداية عد الـ 5 أيام (حجز الكمية على الساب)
    archived: false,               // بيتحول true لما تبدأ شهر جديد
    status: 'unconfirmed',         // Unconfirmed -> Confirmed -> Release -> Delivered (تتغير براحتك في أي وقت)
  });

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

/** الحالات المسموحة لأي طلبية أو صنف جواها */
const ORDER_STATUSES = ['unconfirmed', 'confirmed', 'release', 'delivered'];

/** تغيير حالة الطلبية ككل - براحتك في أي وقت */
function updateOrderStatus(orderId, status) {
  return updateRecord(STORAGE_KEYS.SALES_ORDERS, orderId, { status });
}

/** تغيير حالة صنف واحد جوه طلبية معيّنة (ممكن يختلف عن حالة باقي الأصناف/الطلبية) */
function updateOrderItemStatus(orderId, itemIndex, status) {
  const order = getAll(STORAGE_KEYS.SALES_ORDERS).find((o) => o.id === orderId);
  if (!order) return null;
  const items = order.items.map((it, idx) => (idx === itemIndex ? { ...it, status } : it));
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
function updateOrderItems(orderId, newItems, { cashDiscount } = {}) {
  const order = getAll(STORAGE_KEYS.SALES_ORDERS).find((o) => o.id === orderId);
  if (!order) return null;

  // شيل حركات المخزون القديمة الخاصة بالطلبية دي بس
  const remainingTx = getAll(STORAGE_KEYS.INVENTORY_TX)
    .filter((t) => !(t.refType === 'sales_order' && t.refId === orderId));
  saveAll(STORAGE_KEYS.INVENTORY_TX, remainingTx);

  // حافظ على حالة كل صنف وسعر اللستة الأصلي لو نفس المنتج لسه موجود
  const products = getAll(STORAGE_KEYS.PRODUCTS);
  const itemsWithStatus = newItems.map((it) => {
    const prev = order.items.find((p) => p.productId === it.productId);
    const product = products.find((p) => p.id === it.productId);
    return {
      ...it,
      status: prev?.status || 'unconfirmed',
      listPriceAtSale: prev?.listPriceAtSale ?? (product ? product.basePrice : it.unitPrice),
    };
  });

  const subtotal = itemsWithStatus.reduce((sum, i) => sum + i.qty * i.unitPrice, 0);
  const useCashDiscount = cashDiscount !== undefined ? cashDiscount : order.cashDiscount;
  let discountRate = 0;
  if (useCashDiscount) {
    const customer = getAll(STORAGE_KEYS.CUSTOMERS).find((c) => c.id === order.customerId);
    discountRate = customer?.discountRate || 0;
  }
  const discountAmount = subtotal * (discountRate / 100);
  const total = subtotal - discountAmount;

  const updated = updateRecord(STORAGE_KEYS.SALES_ORDERS, orderId, {
    items: itemsWithStatus, subtotal, cashDiscount: useCashDiscount, discountRate, discountAmount, total,
    editedAt: new Date().toISOString(),
  });

  itemsWithStatus.forEach((item) => {
    addInventoryTransaction({ productId: item.productId, type: 'out', qty: item.qty, refType: 'sales_order', refId: orderId });
  });

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
  saveAll(STORAGE_KEYS.INVENTORY_TX, remainingTx);
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

  const itemsWithPrice = items.map((it) => {
    const orig = order.items.find((oi) => oi.productId === it.productId);
    return { productId: it.productId, qty: it.qty, unitPrice: orig ? orig.unitPrice : 0 };
  });
  const totalValue = itemsWithPrice.reduce((sum, i) => sum + i.qty * i.unitPrice, 0);

  const ret = addRecord(STORAGE_KEYS.RETURNS, {
    orderId, customerId: order.customerId, items: itemsWithPrice, totalValue, date,
  });

  itemsWithPrice.forEach((it) => {
    addInventoryTransaction({ productId: it.productId, type: 'in', qty: it.qty, refType: 'sales_return', refId: ret.id });
  });

  logAudit(orderId, 'مرتجع', `مرتجع بقيمة ${totalValue.toLocaleString()} (${itemsWithPrice.map((i) => i.qty).join('+')} قطعة)`);

  return ret;
}

/** كل المرتجعات المسجّلة على طلبية معيّنة */
function getOrderReturns(orderId) {
  return getAll(STORAGE_KEYS.RETURNS).filter((r) => r.orderId === orderId);
}

/**
 * بداية شهر جديد: كل الطلبيات الحالية بتتحول أرشيف (مش بتتمسح، بتفضل
 * موجودة في كشف حساب العميل وحساباته زي ما هي) وبتختفي من القوائم
 * والتنبيهات النشطة عشان تبدأ تشتغل من الصفر.
 */
function startNewMonth() {
  const active = getActiveOrders();
  active.forEach((o) => updateRecord(STORAGE_KEYS.SALES_ORDERS, o.id, { archived: true, archivedAt: new Date().toISOString() }));
  return active.length;
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
  return updateRecord(STORAGE_KEYS.CHECKS, checkId, { status, deliveryDate: deliveryDate || new Date().toISOString() });
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
function setTarget({ entityType, entityId, period, targetAmount, commissionRate = 0 }) {
  return addRecord(STORAGE_KEYS.TARGETS, { entityType, entityId, period, targetAmount, commissionRate });
}

/** الإنجاز الفعلي = مجموع المبيعات لنفس الكيان في نفس الفترة */
function getTargetProgress(targetId) {
  const target = getAll(STORAGE_KEYS.TARGETS).find((t) => t.id === targetId);
  if (!target) return null;

  const achieved = getAll(STORAGE_KEYS.SALES_ORDERS)
    .filter((o) => {
      const matchesEntity = target.entityType === 'customer' ? o.customerId === target.entityId : o.repId === target.entityId;
      const matchesPeriod = o.date.startsWith(target.period);
      return matchesEntity && matchesPeriod;
    })
    .reduce((sum, o) => sum + o.total, 0);

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
 * deductionPercent (اختياري، لأنواع القيمة بس): بينخصم من المحقق
 * قبل المقارنة بالهدف (زي خصم 14% على MDA).
 * onlyDelivered (اختياري): يحسب بس من الطلبيات اللي حالتها Delivered.
 */
function addKpi({ period, name, metricType, category = null, weight, targetValue, deductionPercent = 0, onlyDelivered = false }) {
  return addRecord(STORAGE_KEYS.KPIS, { period, name, metricType, category, weight, targetValue, deductionPercent, onlyDelivered });
}

function computeKpiAchieved(kpi) {
  const orders = getActiveOrders().filter((o) => o.date.startsWith(kpi.period));
  const products = getAll(STORAGE_KEYS.PRODUCTS);
  const periodReturns = getAll(STORAGE_KEYS.RETURNS).filter((r) => r.date.startsWith(kpi.period));

  if (kpi.metricType === 'active_dealers') {
    const delivered = orders.filter((o) => o.status === 'delivered');
    return new Set(delivered.map((o) => o.customerId)).size;
  }

  const filteredOrders = kpi.onlyDelivered ? orders.filter((o) => o.status === 'delivered') : orders;

  if (kpi.metricType === 'total_value') {
    const raw = filteredOrders.reduce((sum, o) => sum + o.total, 0);
    const returnsValue = periodReturns.reduce((sum, r) => sum + r.totalValue, 0);
    return (raw - returnsValue) * (1 - (kpi.deductionPercent || 0) / 100);
  }

  if (kpi.metricType === 'category_value' || kpi.metricType === 'category_count') {
    let sum = 0;
    filteredOrders.forEach((o) => {
      o.items.forEach((it) => {
        const product = products.find((p) => p.id === it.productId);
        if (product && product.category === kpi.category) {
          sum += kpi.metricType === 'category_count' ? it.qty : it.qty * it.unitPrice;
        }
      });
    });
    periodReturns.forEach((r) => {
      r.items.forEach((it) => {
        const product = products.find((p) => p.id === it.productId);
        if (product && product.category === kpi.category) {
          sum -= kpi.metricType === 'category_count' ? it.qty : it.qty * it.unitPrice;
        }
      });
    });
    return kpi.metricType === 'category_value' ? sum * (1 - (kpi.deductionPercent || 0) / 100) : sum;
  }

  return 0;
}

function getKpiProgress(kpiId) {
  const kpi = getAll(STORAGE_KEYS.KPIS).find((k) => k.id === kpiId);
  if (!kpi) return null;
  const achieved = computeKpiAchieved(kpi);
  const percentage = kpi.targetValue > 0 ? (achieved / kpi.targetValue) * 100 : 0;
  const weightedScore = (percentage / 100) * kpi.weight;
  return { ...kpi, achieved, percentage: Math.round(percentage * 100) / 100, weightedScore: Math.round(weightedScore * 100) / 100 };
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
  Object.entries(jsonData).forEach(([key, value]) => {
    if (Object.values(STORAGE_KEYS).includes(key)) {
      saveAll(key, value);
    }
  });
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
  addCustomer, getCustomerBalance, getCustomerStatement, getCustomerCashCreditMix,
  getOverCreditLimitCustomers, getCustomerAging, getAgingReport,
  getTopCustomers, getTopProducts,
  // مندوبين
  addRep,
  // منتجات ومخزون
  addProduct, getProductStock, addInventoryTransaction, getLowStockAlerts,
  setProductOffer, clearProductOffer, getEffectivePrice,
  addStockStatusUpdate, getLatestStockStatus, getStockStatusHistory,
  // عمليات مركّبة
  recordSale, recordReceipt,
  // حالات الطلبية والأصناف
  ORDER_STATUSES, updateOrderStatus, updateOrderItemStatus,
  // رقم الطلبية والتجديد + إقفال الشهر
  updateOrderNumber, getRenewalDaysLeft, getOrdersNeedingRenewal,
  updateOrderItems, voidOrder,
  recordReturn, getOrderReturns,
  getOrderAuditLog,
  getActiveOrders, startNewMonth,
  // شيكات
  updateCheckDelivery, markCheckCleared, markCheckBounced, getChecksDueSoon,
  // أهداف
  setTarget, getTargetProgress,
  // التارجت الشهري (KPIs)
  addKpi, getKpiProgress, getMonthlyScorecard,
  // نسخ احتياطي
  exportAllData, downloadBackup, importBackup, getDaysSinceLastBackup,
};
