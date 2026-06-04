/**
 * 搜索模块 - 处理天气查询和网页搜索
 */

export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

// ─── 天气查询 ───

/** 判断是否是天气查询 */
export function isWeatherQuery(text: string): boolean {
  return /天气|气温|温度|下雨|晴天|阴天|weather/i.test(text);
}

/** 从查询中提取地点 */
export function extractLocation(text: string): string {
  const patterns = [
    /(.{2,6}?)天气/,
    /(.{2,6}?)气温/,
    /(.{2,6}?)温度/,
    /(.{2,6}?)下雨/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) {
      const loc = m[1].replace(/今天|明天|后天|昨天|现在|这|那/g, "").trim();
      if (loc.length >= 2) return loc;
    }
  }
  return "";
}

/** 获取天气信息 - 使用 wttr.in API */
export async function fetchWeather(location: string): Promise<string> {
  const loc = location || "杭州";
  try {
    console.log(`[天气] 正在获取: ${loc}`);
    const url = `https://wttr.in/${encodeURIComponent(loc)}?format=j1&lang=zh`;
    const response = await fetch(url, {
      headers: { "User-Agent": "curl/7.0" },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`wttr.in returned ${response.status}`);
    }

    const data = await response.json() as WttrResponse;
    const current = data.current_condition?.[0];
    const today = data.weather?.[0];

    if (!current && !today) return "";

    const parts: string[] = [];

    // 地点
    const area = data.nearest_area?.[0];
    if (area) {
      const areaName = area.areaName?.[0]?.value || "";
      const cityName = area.region?.[0]?.value || "";
      const country = area.country?.[0]?.value || "";
      parts.push(`地点: ${areaName}, ${cityName}, ${country}`);
    }

    // 当前天气
    if (current) {
      const desc = current.lang_zh?.[0]?.value || current.weatherDesc?.[0]?.value || "";
      parts.push(`天气: ${desc}`);
      parts.push(`温度: ${current.temp_C}°C (体感 ${current.FeelsLikeC}°C)`);
      parts.push(`湿度: ${current.humidity}%`);
      parts.push(`风: ${current.winddir16Point} ${current.windspeedKmph}km/h`);
      if (current.visibility) parts.push(`能见度: ${current.visibility}km`);
    }

    // 今日预报
    if (today) {
      parts.push(`今日: ${today.mintempC}°C ~ ${today.maxtempC}°C`);
      const astronomy = today.astronomy?.[0];
      if (astronomy?.sunrise) parts.push(`日出: ${astronomy.sunrise} 日落: ${astronomy.sunset}`);
    }

    console.log(`[天气] 获取成功`);
    return parts.join("\n");
  } catch (err) {
    console.error(`[天气] wttr.in 失败: ${err}`);

    // 备用：必应搜索
    try {
      const query = `${loc}今天天气`;
      console.log(`[天气] 备用搜索: ${query}`);
      const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN`;
      const response = await fetch(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept-Language": "zh-CN,zh;q=0.9",
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) return "";
      const html = await response.text();
      const weatherData: string[] = [];

      const tempMatch = html.match(/(\d+)\s*[°℃]/);
      if (tempMatch) weatherData.push(`温度: ${tempMatch[1]}°C`);

      const conditions = ["晴", "多云", "阴", "小雨", "中雨", "大雨", "雷阵雨", "雪", "雾", "霾"];
      for (const c of conditions) {
        if (html.includes(c)) {
          weatherData.push(`天气: ${c}`);
          break;
        }
      }

      if (weatherData.length > 0) {
        console.log(`[天气] 从必应获取到天气`);
        return weatherData.join("\n");
      }

      return "";
    } catch {
      return "";
    }
  }
}

// ─── 必应搜索 ───

export async function bingSearch(query: string): Promise<SearchResult[]> {
  try {
    console.log(`[搜索] 正在搜索: ${query}`);
    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN`;

    const response = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Bing search failed: ${response.status}`);
    }

    const html = await response.text();
    const results: SearchResult[] = [];

    const blocks = html.split(/class="b_algo"/);
    for (let i = 1; i < blocks.length && results.length < 5; i++) {
      const block = blocks[i];
      const titleMatch = block.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
      const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);

      if (titleMatch) {
        const url = titleMatch[1];
        const title = titleMatch[2].replace(/<[^>]+>/g, "").trim();
        const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "";
        if (title && url.startsWith("http")) {
          results.push({ title, snippet, url });
        }
      }
    }

    if (results.length === 0) {
      const linkRegex = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = linkRegex.exec(html)) !== null && results.length < 5) {
        const url = match[1];
        const title = match[2].replace(/<[^>]+>/g, "").trim();
        if (title && !url.includes("bing.com") && !url.includes("microsoft.com")) {
          results.push({ title, snippet: "", url });
        }
      }
    }

    console.log(`[搜索] 找到 ${results.length} 条结果`);
    return results;
  } catch (err) {
    console.error(`[搜索] 搜索失败: ${err}`);
    return [];
  }
}

export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return "";
  const lines = results.map((r, i) => {
    const parts = [`${i + 1}. ${r.title}`];
    if (r.snippet) parts.push(`   ${r.snippet}`);
    if (r.url) parts.push(`   ${r.url}`);
    return parts.join("\n");
  });
  return `\n\n[搜索结果: "${query}"]\n${lines.join("\n")}\n[搜索结果结束]`;
}

/** 判断是否需要搜索 */
export function needsSearch(text: string): boolean {
  const keywords = [
    "天气", "气温", "温度", "下雨",
    "新闻", "最新", "今天", "明天", "昨天",
    "股价", "比分", "赛事", "航班", "快递",
    "谁是", "什么是", "怎么样", "多少钱",
    "搜索", "查一下", "帮我查", "帮我搜",
    "weather", "news", "latest",
  ];
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k));
}

/**
 * 构建搜索上下文（统一处理天气和普通搜索）
 * 返回注入到用户消息中的搜索结果文本
 */
export async function buildSearchContext(userText: string): Promise<string> {
  const isWeather = isWeatherQuery(userText);

  if (isWeather) {
    const location = extractLocation(userText);
    const weatherData = await fetchWeather(location);
    if (weatherData) {
      return `\n\n[天气实况${location ? ": " + location : ""}]\n${weatherData}\n[天气信息结束]\n建议用户访问 https://www.msn.cn/zh-cn/weather/forecast/ 查看详细预报`;
    }
    // 天气获取失败，回退到搜索
    const results = await bingSearch(userText + " 天气实况");
    return formatSearchResults(userText, results);
  }

  const results = await bingSearch(userText);
  return formatSearchResults(userText, results);
}

// ─── 类型定义 ───

interface WttrResponse {
  current_condition?: Array<{
    lang_zh?: Array<{ value: string }>;
    weatherDesc?: Array<{ value: string }>;
    temp_C?: string;
    FeelsLikeC?: string;
    humidity?: string;
    windspeedKmph?: string;
    winddir16Point?: string;
    visibility?: string;
  }>;
  weather?: Array<{
    maxtempC?: string;
    mintempC?: string;
    astronomy?: Array<{
      sunrise: string;
      sunset: string;
    }>;
  }>;
  nearest_area?: Array<{
    areaName?: Array<{ value: string }>;
    region?: Array<{ value: string }>;
    country?: Array<{ value: string }>;
  }>;
}
