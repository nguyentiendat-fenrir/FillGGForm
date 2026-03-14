const fs = require("fs");
const path = require("path");

const DEFAULT_CONFIG = {
  form: {
    url: "",
    submit: false
  },
  browser: {
    headless: false,
    viewport: { width: 1440, height: 900 },
    locale: "vi-VN",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
  },
  paths: {
    answersDir: "answers",
    logsDir: "logs",
    resultsFile: "results.json",
    successLogFile: "success.log",
    failedLogFile: "failed.log",
    schemaPath: "schema.json",
    excelPath: "614.xlsx",
    answersBatchPath: "answers-batch.json"
  },
  fill: {
    concurrency: 5,
    writeResultsEvery: 25,
    retryOnPageClose: true,
    quiet: false
  },
  runtime: {
    navTimeoutMs: 15000,
    actionTimeoutMs: 5000,
    pageReadyTimeoutMs: 5000
  },
  generate: {
    limit: null,
    sampleMode: "all",
    fileNamePadLength: null
  },
  scan: {
    headless: false,
    maxPages: 30,
    guardLimit: 100,
    popupWaitMs: 300,
    postActionWaitMs: 1200,
    waitForNetworkIdleOnStart: false,
    stopPatterns: [
      "xin dừng khảo sát",
      "dừng khảo sát",
      "kết thúc khảo sát",
      "không đủ điều kiện",
      "không phù hợp",
      "không thuộc đối tượng",
      "dừng tại đây",
      "khảo sát kết thúc",
      "survey ends here",
      "not eligible",
      "screen out",
      "terminate",
      "disqualify"
    ]
  }
};

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(base)) {
    return override === undefined ? base : override;
  }

  const output = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (Array.isArray(value)) {
      output[key] = [...value];
      continue;
    }

    if (isPlainObject(value) && isPlainObject(base[key])) {
      output[key] = deepMerge(base[key], value);
      continue;
    }

    output[key] = value;
  }

  return output;
}

function normalizeLegacyConfig(raw) {
  const normalized = { ...(raw || {}) };

  if (normalized.url || normalized.submit !== undefined) {
    normalized.form = {
      ...(normalized.form || {}),
      ...(normalized.url ? { url: normalized.url } : {}),
      ...(normalized.submit !== undefined ? { submit: normalized.submit } : {})
    };
  }

  if (normalized.headless !== undefined || normalized.viewport || normalized.locale || normalized.userAgent) {
    normalized.browser = {
      ...(normalized.browser || {}),
      ...(normalized.headless !== undefined ? { headless: normalized.headless } : {}),
      ...(normalized.viewport ? { viewport: normalized.viewport } : {}),
      ...(normalized.locale ? { locale: normalized.locale } : {}),
      ...(normalized.userAgent ? { userAgent: normalized.userAgent } : {})
    };
  }

  if (normalized.generate && normalized.generate.total !== undefined && normalized.generate.limit === undefined) {
    normalized.generate = {
      ...normalized.generate,
      limit: normalized.generate.total
    };
  }

  return normalized;
}

function loadAppConfig(configPath = path.join(__dirname, "form-config.json")) {
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};

  return deepMerge(DEFAULT_CONFIG, normalizeLegacyConfig(raw));
}

function resolveConfigPath(baseDir, value) {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.join(baseDir, value);
}

module.exports = {
  DEFAULT_CONFIG,
  deepMerge,
  loadAppConfig,
  resolveConfigPath
};
