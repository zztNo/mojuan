/* 听卷音色：把「在线音色」做成可配置的一层。
 *
 * 默认什么都不配，听卷走系统语音（零体积、离线可用）。
 * 填了 Azure 或任意 OpenAI 兼容服务的 key，就改走云端神经音色：
 *   - 体积为零，质量最好，古文断句也自然
 *   - 代价是联网 + 按字符计费（Azure 每月 50 万字符免费）
 *
 * 这里只管「把一句话变成一段音频」，播放、排队、缓存由 app.js 负责。
 * 不存任何默认 key；配置只写在本机 localStorage，不上传。
 */
(function () {
  const VKEY = 'mojuan.voice.v1';

  const DEF = {
    provider: 'local',            // local | azure | openai
    azure: { region: 'eastasia', key: '', voice: 'zh-CN-XiaoxiaoNeural' },
    openai: { base: 'https://api.openai.com/v1', key: '', model: 'tts-1', voice: 'alloy' }
  };

  /* Azure 常用中文音色：晓晓/云希适合白话，云健偏低沉、念史书更稳 */
  const AZURE_VOICES = [
    ['zh-CN-XiaoxiaoNeural', '晓晓 · 女声 · 温润'],
    ['zh-CN-YunxiNeural', '云希 · 男声 · 清朗'],
    ['zh-CN-YunjianNeural', '云健 · 男声 · 低沉'],
    ['zh-CN-YunyeNeural', '云野 · 男声 · 沉稳'],
    ['zh-CN-XiaoyiNeural', '晓伊 · 女声 · 明快'],
    ['zh-CN-YunyangNeural', '云扬 · 男声 · 播报'],
    ['zh-CN-XiaoxuanNeural', '晓萱 · 女声 · 柔和'],
    ['zh-TW-HsiaoChenNeural', '曉臻 · 台湾 · 女声']
  ];
  const OPENAI_VOICES = [
    ['alloy', 'alloy · 中性'], ['echo', 'echo · 男声'], ['fable', 'fable · 叙事'],
    ['onyx', 'onyx · 低沉'], ['nova', 'nova · 女声'], ['shimmer', 'shimmer · 柔和']
  ];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function read() {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(VKEY) || '{}'); } catch (e) { raw = {}; }
    const cfg = clone(DEF);
    if (raw.provider) cfg.provider = raw.provider;
    if (raw.azure) Object.assign(cfg.azure, raw.azure);
    if (raw.openai) Object.assign(cfg.openai, raw.openai);
    return cfg;
  }
  function write(cfg) {
    try { localStorage.setItem(VKEY, JSON.stringify(cfg)); return true; } catch (e) { return false; }
  }
  function getConfig() { return read(); }
  function setConfig(patch) {
    const cfg = read();
    if (patch.provider) cfg.provider = patch.provider;
    if (patch.azure) Object.assign(cfg.azure, patch.azure);
    if (patch.openai) Object.assign(cfg.openai, patch.openai);
    write(cfg);
    return cfg;
  }

  /* 真正可用的在线后端：配了 key 且选中的才算 */
  function active() {
    const c = read();
    if (c.provider === 'azure' && c.azure.key && c.azure.region) return c;
    if (c.provider === 'openai' && c.openai.key && c.openai.base) return c;
    return null;
  }
  function activeLabel() {
    const c = active();
    if (!c) return '';
    if (c.provider === 'azure') {
      const hit = AZURE_VOICES.find((v) => v[0] === c.azure.voice);
      return 'Azure · ' + (hit ? hit[1].split(' · ')[0] : c.azure.voice);
    }
    return '在线 · ' + (c.openai.voice || 'alloy');
  }

  function xmlEsc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  }
  /* 语速 0.5~3 映射到 SSML 的百分比 */
  function ratePct(r) {
    const p = Math.round((Number(r) || 1) * 100 - 100);
    return (p >= 0 ? '+' : '') + p + '%';
  }

  async function azureSpeak(text, cfg, rate, signal) {
    const ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>"
      + "<voice name='" + cfg.voice + "'>"
      + "<prosody rate='" + ratePct(rate) + "'>" + xmlEsc(text) + '</prosody>'
      + '</voice></speak>';
    const r = await fetch('https://' + cfg.region + '.tts.speech.microsoft.com/cognitiveservices/v1', {
      method: 'POST',
      signal,
      headers: {
        'Ocp-Apim-Subscription-Key': cfg.key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3'
      },
      body: ssml
    });
    if (!r.ok) {
      const hint = r.status === 401 ? '密钥无效' : r.status === 403 ? '密钥无权限' : r.status === 429 ? '额度或频率超限' : 'HTTP ' + r.status;
      throw new Error('Azure 语音失败：' + hint);
    }
    return r.blob();
  }

  async function openaiSpeak(text, cfg, rate, signal) {
    const base = String(cfg.base || '').replace(/\/+$/, '');
    const r = await fetch(base + '/audio/speech', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key },
      body: JSON.stringify({
        model: cfg.model || 'tts-1',
        input: text,
        voice: cfg.voice || 'alloy',
        speed: Math.max(0.25, Math.min(4, Number(rate) || 1)),
        response_format: 'mp3'
      })
    });
    if (!r.ok) {
      const hint = r.status === 401 ? '密钥无效' : r.status === 404 ? '接口地址不对（要填到 /v1）' : 'HTTP ' + r.status;
      throw new Error('在线语音失败：' + hint);
    }
    return r.blob();
  }

  /* 一句话 -> 一段音频。没配置就抛错，让上层回退到系统语音。 */
  async function synth(text, opts) {
    const c = active();
    if (!c) throw new Error('没有配置在线音色');
    const rate = (opts && opts.rate) || 1;
    const signal = opts && opts.signal;
    if (c.provider === 'azure') return azureSpeak(text, c.azure, rate, signal);
    return openaiSpeak(text, c.openai, rate, signal);
  }

  window.MJ = window.MJ || {};
  window.MJ.voice = { getConfig, setConfig, active, activeLabel, synth, AZURE_VOICES, OPENAI_VOICES };
})();
