// Site tracking, shared with armoriq.ai: the same Google Tag Manager container
// (it loads GA4 and Clarity) and the same aiq_attr attribution cookie.
// Runs only on armoriq.ai hosts, so local `npm run serve` sessions send nothing.
(function () {
  var host = location.hostname;
  if (host !== 'armoriq.ai' && !/\.armoriq\.ai$/.test(host)) return;

  var GTM_ID = 'GTM-TNQD8NJM';
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
  var gtm = document.createElement('script');
  gtm.async = true;
  gtm.src = 'https://www.googletagmanager.com/gtm.js?id=' + GTM_ID;
  document.head.appendChild(gtm);

  // Same rules as landing lib/attribution.ts: keep rdt_cid and utm_* from the URL
  // for 30 days, latest touch wins. Scoped to .armoriq.ai so a lead form on the
  // main site can read a visit that started here.
  var found = {};
  var count = 0;
  new URLSearchParams(location.search).forEach(function (value, key) {
    var k = key.toLowerCase();
    if ((k === 'rdt_cid' || /^utm_[a-z0-9_]{1,30}$/.test(k)) && value && count < 10) {
      found[k] = value.slice(0, 200);
      count++;
    }
  });
  if (count === 0) return;
  found.landing_page = location.hostname + location.pathname;
  document.cookie = 'aiq_attr=' + encodeURIComponent(JSON.stringify(found)) +
    '; Max-Age=' + 30 * 24 * 60 * 60 + '; Domain=.armoriq.ai; Path=/; SameSite=Lax; Secure';
})();
