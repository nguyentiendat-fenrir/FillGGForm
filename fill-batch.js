const fs = require("fs");
const path = require("path");
const { runFill, createStandaloneBrowser } = require("./fill-form");
const { loadAppConfig, resolveConfigPath } = require("./config-utils");

const BASE_DIR = __dirname;
const CONFIG_PATH = path.join(BASE_DIR, "form-config.json");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeResults(resultsPath, results) {
  const compact = results.filter(Boolean);
  fs.writeFileSync(
    resultsPath,
    JSON.stringify(
      {
        total: compact.length,
        success: compact.filter(x => x.success).length,
        failed: compact.filter(x => !x.success).length,
        items: compact
      },
      null,
      2
    ),
    "utf8"
  );
}

function isPageClosedError(errorText = "") {
  return /Target page, context or browser has been closed/i.test(errorText);
}

function flushLogLines(successLogPath, failedLogPath, successLines, failedLines) {
  if (successLines.length > 0) {
    fs.appendFileSync(successLogPath, successLines.join("\n") + "\n", "utf8");
    successLines.length = 0;
  }

  if (failedLines.length > 0) {
    fs.appendFileSync(failedLogPath, failedLines.join("\n") + "\n", "utf8");
    failedLines.length = 0;
  }
}

async function main() {
  const config = loadAppConfig(CONFIG_PATH);
  const answersDir = resolveConfigPath(BASE_DIR, config.paths.answersDir);
  const logsDir = resolveConfigPath(BASE_DIR, config.paths.logsDir);
  const schemaPath = resolveConfigPath(BASE_DIR, config.paths.schemaPath);
  const resultsPath = path.join(logsDir, config.paths.resultsFile);
  const successLogPath = path.join(logsDir, config.paths.successLogFile);
  const failedLogPath = path.join(logsDir, config.paths.failedLogFile);

  const writeResultsEvery = Math.max(1, Number(config.fill.writeResultsEvery || 25));
  const retryOnPageClose = !!config.fill.retryOnPageClose;
  const quiet = !!config.fill.quiet;
  const concurrency = Math.max(
    1,
    Number(process.env.FILL_CONCURRENCY || config.fill.concurrency || 5)
  );

  ensureDir(logsDir);

  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const files = fs
    .readdirSync(answersDir)
    .filter(name => name.toLowerCase().endsWith(".json"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (files.length === 0) {
    throw new Error("Folder answers không có file json nào");
  }

  const browser = await createStandaloneBrowser(config);
  const results = new Array(files.length);
  const successLines = [];
  const failedLines = [];
  let nextIndex = 0;
  let completed = 0;

  async function worker(workerId) {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= files.length) {
        return;
      }

      const fileName = files[currentIndex];
      const filePath = path.join(answersDir, fileName);

      if (!quiet) {
        console.log(`\n[W${workerId}] [${currentIndex + 1}/${files.length}] Đang xử lý ${fileName}...`);
      }

      let result = await runFill(filePath, {
        browser,
        config,
        schema,
        verbose: false
      });

      if (retryOnPageClose && !result.success && isPageClosedError(result.error || "")) {
        if (!quiet) {
          console.log(`[W${workerId}] Retry ${fileName} vì browser/page bị đóng...`);
        }
        result = await runFill(filePath, {
          browser,
          config,
          schema,
          verbose: false
        });
      }

      const finalResult = {
        time: new Date().toISOString(),
        ...result
      };

      results[currentIndex] = finalResult;
      completed += 1;

      if (finalResult.success) {
        successLines.push(`${new Date().toISOString()} | ${fileName} | OK`);
        if (!quiet) console.log(`[W${workerId}] OK: ${fileName}`);
      } else {
        failedLines.push(
          `${new Date().toISOString()} | ${fileName} | FAIL | ${finalResult.error}`
        );
        if (!quiet) console.log(`[W${workerId}] FAIL: ${fileName} | ${finalResult.error}`);
      }

      if (completed % writeResultsEvery === 0) {
        flushLogLines(successLogPath, failedLogPath, successLines, failedLines);
        writeResults(resultsPath, results);
      }
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, files.length) }, (_, idx) => worker(idx + 1))
    );
  } finally {
    flushLogLines(successLogPath, failedLogPath, successLines, failedLines);
    writeResults(resultsPath, results);
    await browser.close().catch(() => {});
  }

  const compact = results.filter(Boolean);
  const successCount = compact.filter(x => x.success).length;
  const failCount = compact.filter(x => !x.success).length;

  console.log("\n===== DONE =====");
  console.log(`Tổng: ${compact.length}`);
  console.log(`Thành công: ${successCount}`);
  console.log(`Thất bại: ${failCount}`);
  console.log(`Concurrency: ${Math.min(concurrency, files.length)}`);
  console.log(`Log: ${resultsPath}`);
}

main().catch(err => {
  console.error("Lỗi fill-batch:", err.message);
  process.exit(1);
});
