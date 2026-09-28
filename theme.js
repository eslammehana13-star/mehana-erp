if (location.protocol === 'file:') {
  document.addEventListener('DOMContentLoaded', () => {
    const d = document.createElement('div');
    d.style.cssText = 'background:#FFF3CD;border:2px solid #FFB100;border-radius:14px;padding:12px;margin-bottom:14px;font-weight:700';
    d.textContent = '⚠ الصفحة مفتوحة كملف مباشر، والمتصفح بيمنع تشغيل الـ modules كده. شغّل المجلد بسيرفر محلي (مثلاً: python -m http.server) أو ارفعه على استضافة.';
    document.body.prepend(d);
  });
}
