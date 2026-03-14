const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { loadAppConfig, resolveConfigPath } = require("./config-utils");

const BASE_DIR = __dirname;
const CONFIG_PATH = path.join(BASE_DIR, "form-config.json");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeCellValue(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === "object") {
    if (value.text !== undefined) return normalizeCellValue(value.text);
    if (value.result !== undefined) return normalizeCellValue(value.result);
    if (value.richText && Array.isArray(value.richText)) {
      return normalizeText(value.richText.map(x => x.text || "").join(""));
    }
    if (value.formula && value.result !== undefined) return normalizeCellValue(value.result);
    return normalizeText(JSON.stringify(value));
  }

  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : String(value);
  }

  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }

  const text = normalizeText(value);
  return text === "" ? null : text;
}

async function readRowsFromExcel(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error("Không tìm thấy sheet nào trong file Excel");
  }

  const headerRow = worksheet.getRow(1);
  const headers = headerRow.values.slice(1).map(v => normalizeText(v));
  if (!headers.length || headers.every(h => !h)) {
    throw new Error("Dòng header của file Excel đang trống hoặc không hợp lệ");
  }

  const rows = [];

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;

    const values = row.values.slice(1);
    const obj = {};
    let hasAnyValue = false;

    headers.forEach((header, idx) => {
      const normalized = normalizeCellValue(values[idx]);
      obj[header] = normalized;
      if (normalized !== null && normalized !== "") {
        hasAnyValue = true;
      }
    });

    if (hasAnyValue) {
      rows.push({
        rowNumber,
        values: obj
      });
    }
  });

  return rows;
}

function buildSchemaTitleMap(schema) {
  const map = new Map();
  for (const q of schema.questions || []) {
    map.set(normalizeLower(q.title), q);
  }
  return map;
}

function validateAgainstSchema(schema, answers) {
  const qMap = new Map((schema.questions || []).map(q => [q.id, q]));

  for (const ans of answers) {
    const q = qMap.get(ans.id);
    if (!q) {
      throw new Error(`Question id không tồn tại trong schema: ${ans.id}`);
    }

    if (q.type === "radio" || q.type === "dropdown") {
      if (!Array.isArray(q.options) || !q.options.includes(ans.value)) {
        throw new Error(
          `Value không hợp lệ cho ${ans.id}: ${ans.value}. Allowed=${JSON.stringify(q.options || [])}`
        );
      }
    } else if (q.type === "checkbox") {
      if (!Array.isArray(ans.value)) {
        throw new Error(`Câu ${q.id} phải là array`);
      }
      for (const v of ans.value) {
        if (!Array.isArray(q.options) || !q.options.includes(v)) {
          throw new Error(`Value checkbox không hợp lệ cho ${q.id}: ${v}`);
        }
      }
    } else if (typeof ans.value !== "string") {
      throw new Error(`Câu ${q.id} phải là string`);
    }
  }

  for (const q of schema.questions || []) {
    if (q.required) {
      const found = answers.find(a => a.id === q.id);
      if (!found) {
        throw new Error(`Thiếu answer cho câu required: ${q.id}`);
      }
    }
  }
}

function buildAnswerSetFromFullExcelRow(schema, rowWrapper) {
  const schemaTitleMap = buildSchemaTitleMap(schema);
  const row = rowWrapper.values;
  const rowNumber = rowWrapper.rowNumber;
  const answers = [];

  for (const q of schema.questions || []) {
    const matchedQuestion = schemaTitleMap.get(normalizeLower(q.title));
    if (!matchedQuestion) {
      throw new Error(`Không map được câu hỏi trong schema: ${q.title}`);
    }

    const raw = row[q.title];
    const value = normalizeCellValue(raw);

    if (value === null || value === undefined || value === "") {
      if (q.required) {
        throw new Error(`Dòng Excel ${rowNumber}: thiếu dữ liệu cho câu "${q.title}"`);
      }
      continue;
    }

    if (q.type === "radio" || q.type === "dropdown") {
      if (!Array.isArray(q.options) || !q.options.includes(value)) {
        throw new Error(`Dòng Excel ${rowNumber}: value "${value}" không nằm trong options của "${q.title}"`);
      }
      answers.push({ id: q.id, value });
    } else if (q.type === "checkbox") {
      const parts = String(value)
        .split(",")
        .map(x => normalizeText(x))
        .filter(Boolean);
      answers.push({ id: q.id, value: parts });
    } else {
      answers.push({ id: q.id, value: String(value) });
    }
  }

  const order = new Map((schema.questions || []).map((q, i) => [q.id, i]));
  answers.sort((a, b) => order.get(a.id) - order.get(b.id));

  validateAgainstSchema(schema, answers);
  return answers;
}

function shuffle(array) {
  const cloned = [...array];
  for (let i = cloned.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cloned[i], cloned[j]] = [cloned[j], cloned[i]];
  }
  return cloned;
}

function resolveSelectedRows(rows, generateConfig = {}) {
  const sampleMode = String(generateConfig.sampleMode || "all").toLowerCase();
  const rawLimit = generateConfig.limit;
  const parsedLimit = Number(rawLimit);
  const hasLimit = Number.isFinite(parsedLimit) && parsedLimit > 0;

  let selected = [...rows];
  if (sampleMode === "random") {
    selected = shuffle(selected);
  }

  if (hasLimit) {
    selected = selected.slice(0, Math.min(parsedLimit, selected.length));
  }

  return {
    sampleMode,
    selectedRows: selected
  };
}

function getFileNamePadLength(totalItems, configPadLength) {
  const autoPad = Math.max(3, String(Math.max(1, totalItems)).length);
  const manualPad = Number(configPadLength);
  if (Number.isFinite(manualPad) && manualPad > 0) {
    return Math.max(autoPad, Math.floor(manualPad));
  }
  return autoPad;
}

async function main() {
  const config = loadAppConfig(CONFIG_PATH);
  const excelPath = resolveConfigPath(BASE_DIR, config.paths.excelPath);
  const schemaPath = resolveConfigPath(BASE_DIR, config.paths.schemaPath);
  const outputDir = resolveConfigPath(BASE_DIR, config.paths.answersDir);
  const outputBatchPath = resolveConfigPath(BASE_DIR, config.paths.answersBatchPath);

  const schema = loadJson(schemaPath);
  const rowWrappers = await readRowsFromExcel(excelPath);

  if (!rowWrappers.length) {
    throw new Error("Excel không có dòng dữ liệu nào");
  }

  const { sampleMode, selectedRows } = resolveSelectedRows(rowWrappers, config.generate || {});
  ensureDir(outputDir);

  const padLength = getFileNamePadLength(selectedRows.length, config.generate?.fileNamePadLength);
  const items = [];

  selectedRows.forEach((rowWrapper, idx) => {
    const index = idx + 1;
    const answers = buildAnswerSetFromFullExcelRow(schema, rowWrapper);
    const item = {
      index,
      sourceRow: rowWrapper.rowNumber,
      answers
    };

    items.push(item);

    const fileName = `${String(index).padStart(padLength, "0")}.json`;
    fs.writeFileSync(path.join(outputDir, fileName), JSON.stringify(item, null, 2), "utf8");
  });

  fs.writeFileSync(
    outputBatchPath,
    JSON.stringify(
      {
        total: items.length,
        sampleMode,
        sourceExcel: path.basename(excelPath),
        items
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(`Đã tạo ${items.length} bộ answer`);
  console.log(`Folder: ${outputDir}`);
  console.log(`Batch file: ${outputBatchPath}`);
}

main().catch(err => {
  console.error("Generate from Excel lỗi:", err.message);
  process.exit(1);
});
