if (location.protocol === 'file:') {
  document.addEventListener('DOMContentLoaded', () => {
    const d = document.createElement('div');
    d.style.cssText = 'background:#FFF3CD;border:2px solid #FFB100;border-radius:14px;padding:12px;margin-bottom:14px;font-weight:700';
    d.textContent = '⚠ الصفحة مفتوحة كملف مباشر، والمتصفح بيمنع تشغيل الـ modules كده. شغّل المجلد بسيرفر محلي (مثلاً: python -m http.server) أو ارفعه على استضافة.';
    document.body.prepend(d);
  });
}

(function () {
  // ===== إعداد شريط التنقل: الصفحات اللي تفضل ظاهرة، والباقي تحت "المزيد" (عدّل القايمة دي براحتك) =====
  const PINNED = ['index.html', 'invoices.html', 'customers.html', 'inventory.html', 'dealer-targets.html'];

  // ===== إشعارات صغيرة بدل نوافذ alert (اللي بتوقف الشغل) =====
  const nativeAlert = window.alert.bind(window);
  function toast(msg, type) {
    const s = String(msg == null ? '' : msg);
    if (!document.body) { nativeAlert(s); return; }
    let box = document.getElementById('toastBox');
    if (!box) { box = document.createElement('div'); box.id = 'toastBox'; document.body.appendChild(box); }
    const kind = type || (/✅/.test(s) ? 'ok' : /⚠|⛔|مينفعش|لازم|اكتب|الصق|أدخل|اختار|أضف|حدد/.test(s) ? 'warn' : 'info');
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    const txt = document.createElement('div'); txt.className = 'toast-txt'; txt.textContent = s;
    const x = document.createElement('button'); x.type = 'button'; x.className = 'toast-x'; x.textContent = '✕';
    const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 250); };
    x.addEventListener('click', close);
    t.append(txt, x);
    box.appendChild(t);
    setTimeout(close, Math.min(Math.max(3500, 1800 + s.length * 60), 15000));
  }
  window.toast = toast;
  // رسايل الفشل المهمة (حفظ/نسخ) بتفضل نافذة حقيقية عشان متفوتش
  window.alert = function (m) {
    const s = String(m == null ? '' : m);
    if (/تعذّر|مقدرتش/.test(s) || !document.body) return nativeAlert(s);
    toast(s);
  };

  document.addEventListener('DOMContentLoaded', () => {
    const nav = document.querySelector('nav');
    if (!nav) return;
    const cur = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    const links = [...nav.querySelectorAll(':scope > a')];
    const hrefOf = (a) => (a.getAttribute('href') || '').toLowerCase();

    // ----- "المزيد" -----
    const rest = links.filter((a) => !PINNED.includes(hrefOf(a)));
    if (rest.length) {
      const wrap = document.createElement('div');
      wrap.className = 'nav-more';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nav-more-btn' + (rest.some((a) => hrefOf(a) === cur) ? ' active' : '');
      btn.textContent = 'المزيد ▾';
      const menu = document.createElement('div');
      menu.className = 'nav-more-menu';
      rest.forEach((a) => menu.appendChild(a));
      wrap.append(btn, menu);
      nav.appendChild(wrap);
      btn.addEventListener('click', (e) => { e.stopPropagation(); wrap.classList.toggle('open'); });
      document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) wrap.classList.remove('open'); });
    }

    // ----- النسخة الاحتياطية والاستعادة (مكان واحد لكل البرنامج) -----
    const tools = document.createElement('div');
    tools.className = 'nav-tools';
    tools.innerHTML = '<button type="button" class="nav-tool" id="navBackup" title="تنزيل نسخة احتياطية من كل البيانات">⬇ نسخة احتياطية</button>'
      + '<button type="button" class="nav-tool" id="navRestore" title="استعادة نسخة احتياطية">⬆ استعادة</button>'
      + '<input type="file" id="navRestoreFile" accept=".json" style="display:none">';
    nav.appendChild(tools);
    const load = () => import('./erp-data-layer.js');
    document.getElementById('navBackup').addEventListener('click', async () => {
      try { (await load()).downloadBackup(); toast('تم تنزيل النسخة الاحتياطية ✅'); } catch (e) { nativeAlert('تعذّر تنزيل النسخة الاحتياطية'); }
    });
    const fileInput = document.getElementById('navRestoreFile');
    document.getElementById('navRestore').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const mod = await load();
          if (mod.importBackup(JSON.parse(reader.result))) { toast('تم استعادة النسخة الاحتياطية بنجاح ✅'); setTimeout(() => location.reload(), 900); }
        } catch (err) { toast('⚠ ملف غير صالح'); }
        fileInput.value = '';
      };
      reader.readAsText(file);
    });
  });
})();
