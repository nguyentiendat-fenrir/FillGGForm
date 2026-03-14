const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { loadAppConfig, resolveConfigPath } = require("./config-utils");

function normalizeText(s) {
  return (s || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTextLower(s) {
  return normalizeText(s).toLowerCase();
}

function makeQuestionKey(title, type) {
  return `${normalizeTextLower(title)}__${type}`;
}

function questionOptionKey(title, option) {
  return `${normalizeTextLower(title)}__${normalizeTextLower(option)}`;
}

let STOP_PATTERNS = [];

function isStopText(text) {
  const t = normalizeTextLower(text);
  return STOP_PATTERNS.some(x => t.includes(x));
}

function rankOption(text) {
  const t = normalizeTextLower(text);
  if (isStopText(t)) return -100;
  if (t === "có" || t === "yes") return 100;
  if (t === "không" || t.startsWith("không ")) return -30;
  return 0;
}

function cleanQuestionTitle(text) {
  let t = normalizeText(text);

  t = t.replace(/\s*\*\s*/g, " ").trim();
  t = t.replace(/\bĐây là một câu hỏi bắt buộc\b/gi, "").trim();
  t = t.replace(/\bThis is a required question\b/gi, "").trim();
  t = t.replace(/\s+1\s+2\s+3\s+4\s+5.*$/i, "").trim();
  t = t.replace(/\s+Có\s+Không.*$/i, "").trim();
  t = t.replace(/\s+Tùy chọn\s+\d+.*$/i, "").trim();

  return t;
}

async function detectQuestionType(block) {
  const radioCount = await block.getByRole("radio").count().catch(() => 0);
  if (radioCount > 0) return "radio";

  const checkboxCount = await block.getByRole("checkbox").count().catch(() => 0);
  if (checkboxCount > 0) return "checkbox";

  const comboCount = await block.getByRole("combobox").count().catch(() => 0);
  if (comboCount > 0) return "dropdown";

  const textboxCount = await block.getByRole("textbox").count().catch(() => 0);
  if (textboxCount > 1) return "text_multi";
  if (textboxCount === 1) return "text";

  return "unknown";
}

async function detectRequired(block) {
  const raw = normalizeText(await block.innerText().catch(() => ""));
  return /\*/.test(raw) ||
    /Đây là một câu hỏi bắt buộc/i.test(raw) ||
    /This is a required question/i.test(raw);
}

async function extractQuestionTitle(block) {
  const headingCandidates = [
    block.locator('[role="heading"]'),
    block.locator('div[role="heading"]'),
    block.locator("h1, h2, h3, h4, h5, h6")
  ];

  for (const locator of headingCandidates) {
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const txt = normalizeText(await locator.nth(i).innerText().catch(() => ""));
      if (txt && txt.length > 1) {
        return cleanQuestionTitle(txt);
      }
    }
  }

  const raw = normalizeText(await block.innerText().catch(() => ""));
  return cleanQuestionTitle(raw);
}

async function extractOptions(page, block, type) {
  const options = [];

  if (type === "radio") {
    const radios = block.getByRole("radio");
    const count = await radios.count();
    for (let i = 0; i < count; i++) {
      const label = await radios.nth(i).getAttribute("aria-label").catch(() => null);
      if (label) options.push(normalizeText(label));
    }
  }

  if (type === "checkbox") {
    const checkboxes = block.getByRole("checkbox");
    const count = await checkboxes.count();
    for (let i = 0; i < count; i++) {
      const label = await checkboxes.nth(i).getAttribute("aria-label").catch(() => null);
      if (label) options.push(normalizeText(label));
    }
  }

  if (type === "dropdown") {
    const combo = block.getByRole("combobox").first();
    await combo.click().catch(() => {});
    await page.waitForTimeout(activeScanConfig.popupWaitMs || 300);

    const popupOptions = page.getByRole("option");
    const count = await popupOptions.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const txt = normalizeText(await popupOptions.nth(i).innerText().catch(() => ""));
      if (txt) options.push(txt);
    }

    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(Math.max(50, Math.floor((activeScanConfig.popupWaitMs || 300) / 3)));
  }

  return [...new Set(options)];
}

async function getPageSignature(page) {
  const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
  return bodyText;
}
async function getRealPageSignature(page) {
  const listItems = page.getByRole("listitem");
  const count = await listItems.count().catch(() => 0);
  const titles = [];

  for (let i = 0; i < count; i++) {
    const block = listItems.nth(i);
    const type = await detectQuestionType(block);
    if (type === "unknown") continue;

    const title = await extractQuestionTitle(block);
    if (title) titles.push(title);
  }

  const hasNext = !!(await findNextButton(page));
  const hasSubmit = !!(await findSubmitButton(page));

  // nếu có câu hỏi thì signature dựa chủ yếu vào title câu hỏi
  if (titles.length > 0) {
    return `Q|${titles.join(" | ")}|next=${hasNext}|submit=${hasSubmit}`;
  }

  // nếu không có câu hỏi thì fallback theo body text rút gọn
  const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
  return `NQ|next=${hasNext}|submit=${hasSubmit}|${bodyText.slice(0, 300)}`;
}

async function isTerminationPage(page) {
  const bodyText = normalizeTextLower(await page.locator("body").innerText().catch(() => ""));
  return isStopText(bodyText);
}

async function findNextButton(page) {
  const candidates = [
    page.getByRole("button", { name: /^tiếp$/i }),
    page.getByRole("button", { name: /^next$/i }),
    page.getByRole("button", { name: /tiếp theo/i }),
    page.getByRole("button", { name: /next/i }),
    page.locator('text="Tiếp"'),
    page.locator('text="Next"')
  ];

  for (const btn of candidates) {
    const count = await btn.count().catch(() => 0);
    if (count > 0) {
      const first = btn.first();
      const visible = await first.isVisible().catch(() => false);
      if (visible) return first;
    }
  }

  return null;
}

async function findSubmitButton(page) {
  const candidates = [
    page.getByRole("button", { name: /^gửi$/i }),
    page.getByRole("button", { name: /^submit$/i }),
    page.getByRole("button", { name: /gửi/i }),
    page.getByRole("button", { name: /submit/i }),
    page.locator('text="Gửi"'),
    page.locator('text="Submit"')
  ];

  for (const btn of candidates) {
    const count = await btn.count().catch(() => 0);
    if (count > 0) {
      const first = btn.first();
      const visible = await first.isVisible().catch(() => false);
      if (visible) return first;
    }
  }

  return null;
}

async function scanCurrentPageQuestions(page, pageIndex, questionsMap) {
  const listItems = page.getByRole("listitem");
  const count = await listItems.count();
  let foundThisPage = 0;

  for (let i = 0; i < count; i++) {
    const block = listItems.nth(i);
    const blockText = normalizeText(await block.innerText().catch(() => ""));
    if (!blockText) continue;

    const type = await detectQuestionType(block);
    if (type === "unknown") continue;

    const title = await extractQuestionTitle(block);
    if (!title) continue;

    const required = await detectRequired(block);
    const options = await extractOptions(page, block, type);
    const key = makeQuestionKey(title, type);

    if (!questionsMap.has(key)) {
      questionsMap.set(key, {
        id: `q_${questionsMap.size + 1}`,
        title,
        type,
        required,
        options,
        page: pageIndex
      });
      foundThisPage++;
    } else {
      const old = questionsMap.get(key);
      old.options = [...new Set([...(old.options || []), ...options])];
      old.required = old.required || required;
      questionsMap.set(key, old);
    }
  }

  return foundThisPage;
}

async function getRequiredQuestions(page) {
  const listItems = page.getByRole("listitem");
  const count = await listItems.count();
  const result = [];

  for (let i = 0; i < count; i++) {
    const block = listItems.nth(i);
    const required = await detectRequired(block);
    if (!required) continue;

    const type = await detectQuestionType(block);
    if (type === "unknown") continue;

    const title = await extractQuestionTitle(block);
    const options = await extractOptions(page, block, type);

    result.push({ index: i, block, type, title, options });
  }

  return result;
}

async function applyPathSelections(page, path) {
  const listItems = page.getByRole("listitem");
  const count = await listItems.count();

  for (let i = 0; i < count; i++) {
    const block = listItems.nth(i);
    const type = await detectQuestionType(block);
    if (type === "unknown") continue;

    const title = await extractQuestionTitle(block);
    const match = path.find(x => normalizeTextLower(x.title) === normalizeTextLower(title));
    if (!match) continue;

    if (type === "text" || type === "text_multi") {
      const textboxes = block.getByRole("textbox");
      const tbCount = await textboxes.count();
      for (let j = 0; j < tbCount; j++) {
        await textboxes.nth(j).fill(`scan_${i + 1}_${j + 1}`);
      }
    } else if (type === "radio") {
      const radios = block.getByRole("radio");
      const rc = await radios.count();
      for (let k = 0; k < rc; k++) {
        const label = await radios.nth(k).getAttribute("aria-label").catch(() => "");
        if (normalizeTextLower(label) === normalizeTextLower(match.option)) {
          await radios.nth(k).click({ force: true }).catch(() => {});
          break;
        }
      }
    } else if (type === "checkbox") {
      const checkboxes = block.getByRole("checkbox");
      const cc = await checkboxes.count();
      for (let k = 0; k < cc; k++) {
        const label = await checkboxes.nth(k).getAttribute("aria-label").catch(() => "");
        if (normalizeTextLower(label) === normalizeTextLower(match.option)) {
          await checkboxes.nth(k).click({ force: true }).catch(() => {});
          break;
        }
      }
    } else if (type === "dropdown") {
      const combo = block.getByRole("combobox").first();
      await combo.click().catch(() => {});
      await page.waitForTimeout(250);

      const opts = page.getByRole("option");
      const oc = await opts.count().catch(() => 0);
      for (let k = 0; k < oc; k++) {
        const label = normalizeText(await opts.nth(k).innerText().catch(() => ""));
        if (normalizeTextLower(label) === normalizeTextLower(match.option)) {
          await opts.nth(k).click().catch(() => {});
          break;
        }
      }
    }
  }
}

async function fillRequiredSmart(page, triedBadOptions, chosenPath) {
  const requiredQuestions = await getRequiredQuestions(page);

  for (const q of requiredQuestions) {
    if (q.type === "text" || q.type === "text_multi") {
      const textboxes = q.block.getByRole("textbox");
      const tbCount = await textboxes.count();
      for (let j = 0; j < tbCount; j++) {
        const currentValue = await textboxes.nth(j).inputValue().catch(() => "");
        if (!currentValue) {
          await textboxes.nth(j).fill(`scan_${q.index + 1}_${j + 1}`);
        }
      }
      continue;
    }

    if (q.type === "radio") {
      let alreadyChecked = false;
      const radios = q.block.getByRole("radio");
      const rc = await radios.count();

      for (let k = 0; k < rc; k++) {
        const checked = await radios.nth(k).getAttribute("aria-checked").catch(() => "false");
        if (checked === "true") {
          alreadyChecked = true;
          break;
        }
      }
      if (alreadyChecked) continue;

      const choices = [];
      for (let k = 0; k < rc; k++) {
        const label = await radios.nth(k).getAttribute("aria-label").catch(() => "");
        if (label) choices.push({ index: k, label });
      }

      choices.sort((a, b) => rankOption(b.label) - rankOption(a.label));
      const candidate =
        choices.find(c => !triedBadOptions.has(questionOptionKey(q.title, c.label))) || choices[0];

      if (candidate) {
        await radios.nth(candidate.index).click({ force: true }).catch(() => {});
        chosenPath.push({ title: q.title, option: candidate.label, type: q.type });
      }
      continue;
    }

    if (q.type === "checkbox") {
      const checkboxes = q.block.getByRole("checkbox");
      const cc = await checkboxes.count();

      let checkedCount = 0;
      for (let k = 0; k < cc; k++) {
        const checked = await checkboxes.nth(k).getAttribute("aria-checked").catch(() => "false");
        if (checked === "true") checkedCount++;
      }
      if (checkedCount > 0) continue;

      const choices = [];
      for (let k = 0; k < cc; k++) {
        const label = await checkboxes.nth(k).getAttribute("aria-label").catch(() => "");
        if (label) choices.push({ index: k, label });
      }

      choices.sort((a, b) => rankOption(b.label) - rankOption(a.label));
      const candidate =
        choices.find(c => !triedBadOptions.has(questionOptionKey(q.title, c.label))) || choices[0];

      if (candidate) {
        await checkboxes.nth(candidate.index).click({ force: true }).catch(() => {});
        chosenPath.push({ title: q.title, option: candidate.label, type: q.type });
      }
      continue;
    }

    if (q.type === "dropdown") {
      const combo = q.block.getByRole("combobox").first();
      await combo.click().catch(() => {});
      await page.waitForTimeout(250);

      const opts = page.getByRole("option");
      const oc = await opts.count().catch(() => 0);

      const choices = [];
      for (let k = 0; k < oc; k++) {
        const label = normalizeText(await opts.nth(k).innerText().catch(() => ""));
        if (label) choices.push({ index: k, label });
      }

      choices.sort((a, b) => rankOption(b.label) - rankOption(a.label));
      const candidate =
        choices.find(c => !triedBadOptions.has(questionOptionKey(q.title, c.label))) || choices[0];

      if (candidate) {
        await opts.nth(candidate.index).click().catch(() => {});
        chosenPath.push({ title: q.title, option: candidate.label, type: q.type });
      } else {
        await page.keyboard.press("Escape").catch(() => {});
      }
    }
  }
}

async function restartAndReplay(page, url, successfulPath) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  for (const step of successfulPath) {
    await applyPathSelections(page, [step]);

    const nextBtn = await findNextButton(page);
    if (nextBtn) {
      await nextBtn.click().catch(() => {});
      await page.waitForTimeout(1000);
    }
  }
}

async function collectPageMeta(page, pageIndex, questionsMap) {
  const foundThisPage = await scanCurrentPageQuestions(page, pageIndex, questionsMap);
  const nextBtn = await findNextButton(page);
  const submitBtn = await findSubmitButton(page);

  return {
    page: pageIndex,
    questionCount: foundThisPage,
    hasNext: !!nextBtn,
    hasSubmit: !!submitBtn
  };
}

const activeScanConfig = { popupWaitMs: 300, postActionWaitMs: 1200, maxPages: 30, guardLimit: 100, waitForNetworkIdleOnStart: false };

(async () => {
  const config = loadAppConfig(path.join(__dirname, "form-config.json"));
  Object.assign(activeScanConfig, config.scan || {});
  STOP_PATTERNS = Array.isArray(config.scan?.stopPatterns) ? [...config.scan.stopPatterns] : [];
  const browser = await chromium.launch({ headless: config.scan?.headless ?? config.browser?.headless ?? false });
  const page = await browser.newPage();

  const triedBadOptions = new Set();
  const confirmedPath = [];
  const questionsMap = new Map();
  const pagesMeta = [];
  const seenRealPages = new Set();
  let realPageNo = 0;

  try {
    const formUrl = config.form?.url || config.url;
    await page.goto(formUrl, { waitUntil: "domcontentloaded" });
    if (activeScanConfig.waitForNetworkIdleOnStart) {
      await page.waitForLoadState("networkidle").catch(() => {});
    }

    let pageIndex = 1;
    let guard = 0;

  while (pageIndex <= (activeScanConfig.maxPages || 30) && guard < (activeScanConfig.guardLimit || 100)) {
    guard++;

    const realSignature = await getRealPageSignature(page);

    if (!seenRealPages.has(realSignature)) {
      seenRealPages.add(realSignature);
      realPageNo++;

      console.log(`Đang scan trang thật ${realPageNo}...`);

      const meta = await collectPageMeta(page, realPageNo, questionsMap);
      pagesMeta.push(meta);

      console.log(
        `  -> câu mới: ${meta.questionCount}, hasNext=${meta.hasNext}, hasSubmit=${meta.hasSubmit}`
      );

      // nếu đã tới trang submit thật thì dừng
      if (meta.hasSubmit && !meta.hasNext) {
        console.log(`Đã tới trang submit ở page ${realPageNo}`);
        break;
      }
    } else {
      console.log("  -> trùng trang đã scan, không cộng page");
    }

    const before = await getRealPageSignature(page);
    const nextBtn = await findNextButton(page);

    if (!nextBtn) {
      console.log(`Dừng: Không tìm thấy nút Tiếp`);
      break;
    }

    await nextBtn.click().catch(() => {});
    await page.waitForTimeout(1000);

    // nếu đi vào nhánh out thì quay lại và thử fill required
    if (await isTerminationPage(page)) {
      console.log(`  -> dính nhánh out, reload thử lại`);
      await restartAndReplay(page, formUrl, confirmedPath);

      const tempChosen = [];
      await fillRequiredSmart(page, triedBadOptions, tempChosen);

      const nextBtn2 = await findNextButton(page);
      if (!nextBtn2) {
        console.log(`Dừng: Không tìm thấy nút Tiếp sau khi fill`);
        break;
      }

      await nextBtn2.click().catch(() => {});
      await page.waitForTimeout(activeScanConfig.postActionWaitMs || 1200);

      if (await isTerminationPage(page)) {
        for (const item of tempChosen) {
          triedBadOptions.add(questionOptionKey(item.title, item.option));
          console.log(`  -> đánh dấu bad option: [${item.title}] = ${item.option}`);
        }

        await restartAndReplay(page, formUrl, confirmedPath);
        await fillRequiredSmart(page, triedBadOptions, tempChosen);

        const nextBtn3 = await findNextButton(page);
        if (!nextBtn3) {
          console.log(`Dừng: Không còn đường đi hợp lệ`);
          break;
        }

        await nextBtn3.click().catch(() => {});
        await page.waitForTimeout(activeScanConfig.postActionWaitMs || 1200);

        if (await isTerminationPage(page)) {
          console.log(`Dừng: Thử lại vẫn vào nhánh out`);
          break;
        } else {
          confirmedPath.push(...tempChosen);
        }
      } else {
        confirmedPath.push(...tempChosen);
      }
    } else {
      const after = await getRealPageSignature(page);

      if (after === before) {
        // có thể do required chưa điền, thử fill required rồi đi tiếp
        const tempChosen = [];
        await fillRequiredSmart(page, triedBadOptions, tempChosen);

        const nextBtn4 = await findNextButton(page);
        if (!nextBtn4) {
          console.log(`Dừng: Không tìm thấy nút Tiếp sau fill required`);
          break;
        }

        await nextBtn4.click().catch(() => {});
        await page.waitForTimeout(activeScanConfig.postActionWaitMs || 1200);

        if (await isTerminationPage(page)) {
          for (const item of tempChosen) {
            triedBadOptions.add(questionOptionKey(item.title, item.option));
            console.log(`  -> bad option sau fill: [${item.title}] = ${item.option}`);
          }

          await restartAndReplay(page, formUrl, confirmedPath);
          continue;
        }

        confirmedPath.push(...tempChosen);
      }
    }

    pageIndex++;
  }

    const questions = Array.from(questionsMap.values());

    const schema = {
      url: formUrl,
      scannedAt: new Date().toISOString(),
      totalPagesScanned: pagesMeta.length,
      questionPages: pagesMeta.filter(p => p.questionCount > 0).length,
      hasSubmitPage: pagesMeta.some(p => p.hasSubmit),
      questionCount: questions.length,
      questions,
      pages: pagesMeta,
      confirmedPath,
      triedBadOptions: Array.from(triedBadOptions)
    };

    const schemaOutputPath = resolveConfigPath(__dirname, config.paths?.schemaPath || "schema.json");
    fs.writeFileSync(schemaOutputPath, JSON.stringify(schema, null, 2), "utf8");
    console.log("Đã lưu schema.json");
    console.log(`Tổng câu hỏi: ${questions.length}`);
    console.log(`Tổng page scan được: ${pagesMeta.length}`);
  } catch (err) {
    console.error("Scan lỗi:", err.message);
  } finally {
    await browser.close().catch(() => {});
  }
})();