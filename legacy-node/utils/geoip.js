/**
 * IP 归属地查询（基于 ipapi.co 免费接口，无需 API Key）
 * 单机限制：45 次/分钟
 */
const http = require('http');

function queryIP(ip) {
  // 本地/内网地址不查，直接写"内网"
  if (!ip || ip === 'unknown' || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.16.')) {
    return Promise.resolve('内网');
  }
  // 去除 IPv6 前缀
  const cleanIP = ip.replace(/^::ffff:/, '');

  return new Promise((resolve) => {
    // 使用 ip-api.com（免费，支持 IPv6，无需 API Key）
    const url = `http://ip-api.com/json/${cleanIP}?lang=zh-CN`;
    http.get(url, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.status === 'fail') { resolve('未知'); return; }
          if (j.city && j.country) {
            resolve(j.country === '中国' ? `${j.regionName}${j.city}` : `${j.country} ${j.city}`);
          } else if (j.country) {
            resolve(j.country);
          } else {
            resolve('未知');
          }
        } catch { resolve('未知'); }
      });
    }).on('error', () => resolve('未知'))
      .on('timeout', () => resolve('未知'));
  });
}

module.exports = { queryIP };
