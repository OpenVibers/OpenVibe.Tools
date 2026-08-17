/**
 * Weather Module – Open-Meteo (Primary) + NWS Alerts
 * Open-Meteo: Free, reliable, no API key.
 * NWS: Only used for weather alerts (optional).
 *
 * Returns unified: { current, daily[], hourly[], alerts[], sun, moon }
 */
const axios = require('axios');

const UA = 'GhostCamp-WA/2.0 (stealth-camping-locator)';

// WMO Weather Codes → human-readable descriptions + FA icons
const WMO_CODES = {
  0: { description: 'Clear sky', icon: 'fa-sun', cls: 'clear' },
  1: { description: 'Mainly clear', icon: 'fa-cloud-sun', cls: 'clear' },
  2: { description: 'Partly cloudy', icon: 'fa-cloud-sun', cls: 'cloudy' },
  3: { description: 'Overcast', icon: 'fa-cloud', cls: 'cloudy' },
  45: { description: 'Foggy', icon: 'fa-smog', cls: 'fog' },
  48: { description: 'Freezing fog', icon: 'fa-smog', cls: 'fog' },
  51: { description: 'Light drizzle', icon: 'fa-cloud-rain', cls: 'rain' },
  53: { description: 'Moderate drizzle', icon: 'fa-cloud-rain', cls: 'rain' },
  55: { description: 'Dense drizzle', icon: 'fa-cloud-showers-heavy', cls: 'rain' },
  56: { description: 'Freezing drizzle', icon: 'fa-cloud-rain', cls: 'rain' },
  57: { description: 'Heavy freezing drizzle', icon: 'fa-cloud-showers-heavy', cls: 'rain' },
  61: { description: 'Slight rain', icon: 'fa-cloud-rain', cls: 'rain' },
  63: { description: 'Moderate rain', icon: 'fa-cloud-showers-heavy', cls: 'rain' },
  65: { description: 'Heavy rain', icon: 'fa-cloud-showers-heavy', cls: 'rain' },
  66: { description: 'Freezing rain', icon: 'fa-cloud-rain', cls: 'rain' },
  67: { description: 'Heavy freezing rain', icon: 'fa-cloud-showers-heavy', cls: 'rain' },
  71: { description: 'Slight snow', icon: 'fa-snowflake', cls: 'snow' },
  73: { description: 'Moderate snow', icon: 'fa-snowflake', cls: 'snow' },
  75: { description: 'Heavy snow', icon: 'fa-snowflake', cls: 'snow' },
  77: { description: 'Snow grains', icon: 'fa-snowflake', cls: 'snow' },
  80: { description: 'Light showers', icon: 'fa-cloud-sun-rain', cls: 'rain' },
  81: { description: 'Moderate showers', icon: 'fa-cloud-showers-heavy', cls: 'rain' },
  82: { description: 'Violent showers', icon: 'fa-cloud-showers-heavy', cls: 'rain' },
  85: { description: 'Light snow showers', icon: 'fa-snowflake', cls: 'snow' },
  86: { description: 'Heavy snow showers', icon: 'fa-snowflake', cls: 'snow' },
  95: { description: 'Thunderstorm', icon: 'fa-bolt', cls: 'storm' },
  96: { description: 'Thunderstorm w/ hail', icon: 'fa-cloud-bolt', cls: 'storm' },
  99: { description: 'Severe thunderstorm', icon: 'fa-cloud-bolt', cls: 'storm' },
};

function decodeWMO(code, isDay) {
  const entry = WMO_CODES[code] || { description: 'Unknown', icon: 'fa-question', cls: 'unknown' };
  // Swap sun icons for moon icons at night
  let icon = entry.icon;
  if (!isDay && icon === 'fa-sun') icon = 'fa-moon';
  if (!isDay && icon === 'fa-cloud-sun') icon = 'fa-cloud-moon';
  if (!isDay && icon === 'fa-cloud-sun-rain') icon = 'fa-cloud-moon-rain';
  return { ...entry, icon };
}

/**
 * Get comprehensive weather data for a lat/lon.
 * Uses Open-Meteo as the primary (reliable) source.
 * NWS only for weather alerts.
 */
async function getWeather(lat, lon) {
  const result = {
    current: null,
    daily: [],
    hourly: [],
    alerts: [],
    sun: {},
    moon: {},
    forecast: { shortForecast: '', detailedForecast: '' },
  };

  // ─── Open-Meteo: current + daily + hourly ───
  try {
    const params = [
      `latitude=${lat}`, `longitude=${lon}`,
      'current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day',
      'daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,sunrise,sunset,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,uv_index_max',
      'hourly=temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,wind_speed_10m,weather_code,is_day',
      'temperature_unit=fahrenheit',
      'wind_speed_unit=mph',
      'precipitation_unit=inch',
      'timezone=America/Los_Angeles',
      'forecast_days=7',
      'forecast_hours=48',
    ].join('&');

    const resp = await axios.get(`https://api.open-meteo.com/v1/forecast?${params}`, { timeout: 10000 });
    const d = resp.data;

    // Current conditions
    if (d.current) {
      const wmo = decodeWMO(d.current.weather_code, d.current.is_day);
      result.current = {
        temperature: Math.round(d.current.temperature_2m),
        feelsLike: Math.round(d.current.apparent_temperature),
        humidity: d.current.relative_humidity_2m,
        windSpeed: Math.round(d.current.wind_speed_10m),
        windGusts: d.current.wind_gusts_10m ? Math.round(d.current.wind_gusts_10m) : null,
        windDir: d.current.wind_direction_10m,
        precipitation: d.current.precipitation,
        weatherCode: d.current.weather_code,
        description: wmo.description,
        icon: wmo.icon,
        cls: wmo.cls,
        isDay: d.current.is_day === 1,
      };
      result.forecast.shortForecast = wmo.description;
    }

    // Daily forecast (7 days)
    if (d.daily) {
      const dl = d.daily;
      for (let i = 0; i < (dl.time?.length || 0); i++) {
        const wmo = decodeWMO(dl.weather_code[i], true);
        result.daily.push({
          date: dl.time[i],
          tempHigh: Math.round(dl.temperature_2m_max[i]),
          tempLow: Math.round(dl.temperature_2m_min[i]),
          feelsHigh: Math.round(dl.apparent_temperature_max[i]),
          feelsLow: Math.round(dl.apparent_temperature_min[i]),
          sunrise: dl.sunrise[i],
          sunset: dl.sunset[i],
          precipSum: dl.precipitation_sum[i],
          precipChance: dl.precipitation_probability_max[i],
          windMax: Math.round(dl.wind_speed_10m_max[i]),
          uvIndex: dl.uv_index_max[i],
          weatherCode: dl.weather_code[i],
          description: wmo.description,
          icon: wmo.icon,
          cls: wmo.cls,
        });
      }

      // Sun data from today
      if (dl.sunrise?.[0]) result.sun.sunrise = dl.sunrise[0];
      if (dl.sunset?.[0]) result.sun.sunset = dl.sunset[0];
      if (dl.uv_index_max?.[0] != null) result.sun.uvIndex = dl.uv_index_max[0];
    }

    // Hourly forecast (48 hours)
    if (d.hourly) {
      const hl = d.hourly;
      for (let i = 0; i < Math.min(hl.time?.length || 0, 48); i++) {
        const wmo = decodeWMO(hl.weather_code[i], hl.is_day?.[i] === 1);
        result.hourly.push({
          time: hl.time[i],
          temp: Math.round(hl.temperature_2m[i]),
          humidity: hl.relative_humidity_2m[i],
          precipChance: hl.precipitation_probability[i],
          precipitation: hl.precipitation[i],
          windSpeed: Math.round(hl.wind_speed_10m[i]),
          weatherCode: hl.weather_code[i],
          description: wmo.description,
          icon: wmo.icon,
          isDay: hl.is_day?.[i] === 1,
        });
      }
    }

    // Build a detailed forecast string from daily[0]
    if (result.daily[0]) {
      const today = result.daily[0];
      result.forecast.detailedForecast = `${today.description}. High ${today.tempHigh}°F, low ${today.tempLow}°F. Wind up to ${today.windMax} mph. ${today.precipChance > 0 ? `${today.precipChance}% chance of precipitation.` : 'No precipitation expected.'} UV index: ${today.uvIndex}.`;
    }
  } catch (err) {
    console.warn('[Weather Open-Meteo]', err.message);
  }

  // ─── Moon phase ───
  const moon = calculateMoonPhase(new Date());
  result.moon = {
    phase: moon.phase,
    name: moon.name,
    emoji: moon.emoji,
    illumination: moon.illumination / 100,
    stealthRating: moon.stealthBonus,
  };

  // ─── NWS Alerts only ───
  try {
    const ptResp = await axios.get(`https://api.weather.gov/points/${lat},${lon}`, {
      headers: { 'User-Agent': UA, Accept: 'application/geo+json' },
      timeout: 5000,
    });
    const zone = ptResp.data?.properties?.forecastZone;
    if (zone) {
      const zoneId = zone.split('/').pop();
      const alertResp = await axios.get(`https://api.weather.gov/alerts/active?zone=${zoneId}`, {
        headers: { 'User-Agent': UA },
        timeout: 5000,
      });
      result.alerts = (alertResp.data?.features || []).map(f => ({
        event: f.properties.event,
        severity: f.properties.severity,
        headline: f.properties.headline,
        description: f.properties.description,
        instruction: f.properties.instruction,
        expires: f.properties.expires,
      }));
    }
  } catch (e) {
    // NWS alerts are optional; don't fail if unavailable
  }

  return result;
}

/**
 * Moon phase calculator (synodic period 29.53 days)
 */
function calculateMoonPhase(date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();

  let c, e;
  if (month < 3) { c = year - 1; e = month + 12; } else { c = year; e = month; }
  const jd = Math.floor(365.25 * (c + 4716)) + Math.floor(30.6001 * (e + 1)) + day - 1524.5;
  const daysSinceNew = jd - 2451549.5;
  const phase = ((daysSinceNew / 29.53058867) % 1 + 1) % 1 * 29.53058867;

  let name, emoji;
  if (phase < 1.8) { name = 'New Moon'; emoji = '🌑'; }
  else if (phase < 5.5) { name = 'Waxing Crescent'; emoji = '🌒'; }
  else if (phase < 9.2) { name = 'First Quarter'; emoji = '🌓'; }
  else if (phase < 12.9) { name = 'Waxing Gibbous'; emoji = '🌔'; }
  else if (phase < 16.6) { name = 'Full Moon'; emoji = '🌕'; }
  else if (phase < 20.3) { name = 'Waning Gibbous'; emoji = '🌖'; }
  else if (phase < 24.0) { name = 'Last Quarter'; emoji = '🌗'; }
  else if (phase < 27.7) { name = 'Waning Crescent'; emoji = '🌘'; }
  else { name = 'New Moon'; emoji = '🌑'; }

  const illumination = Math.round((1 - Math.cos(2 * Math.PI * (phase / 29.53058867))) / 2 * 100);
  const stealthBonus = phase < 3 || phase > 26 ? '★★★★★ Perfect Dark' :
    phase < 8 || phase > 22 ? '★★★★☆ Very Dark' :
    phase < 13 || phase > 17 ? '★★★☆☆ Moderate' : '★★☆☆☆ Bright';

  return { phase: Math.round(phase * 10) / 10, name, emoji, illumination, stealthBonus };
}

module.exports = { getWeather, calculateMoonPhase, WMO_CODES, decodeWMO };
