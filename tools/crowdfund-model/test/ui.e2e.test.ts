// ABOUTME: End-to-end tests for crowdfund-model.html: loads the real file in jsdom and drives it like a user
// ABOUTME: (add rows, type commits, self-fill, toggle, import/export CSV, reload from localStorage).

import { expect } from "chai";
import { JSDOM } from "jsdom";
import { loadModel, readModelHtml } from "./loadModel";

const { scenario } = loadModel();
const STORAGE_KEY = "armada-crowdfund-model/v1";

interface Page {
  window: any;
  document: Document;
  downloads: { filename: string; text: Promise<string> }[];
}

/** Opens the model in jsdom. `stored` pre-populates localStorage before the page scripts run. */
function open(stored?: string): Page {
  const downloads: Page["downloads"] = [];
  const dom = new JSDOM(readModelHtml(), {
    url: "http://localhost/crowdfund-model.html",
    runScripts: "dangerously",
    beforeParse(window: any) {
      if (stored !== undefined) window.localStorage.setItem(STORAGE_KEY, stored);
      window.confirm = () => true;
      // jsdom has no object URLs or downloads: capture what the page would save.
      window.URL.createObjectURL = (blob: any) => {
        downloads.push({ filename: "", text: blob.text() });
        return "blob:captured";
      };
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = function (this: any) {
        downloads[downloads.length - 1].filename = this.download;
      };
    },
  });
  return { window: dom.window, document: dom.window.document, downloads };
}

const text = (page: Page, selector: string) => {
  const el = page.document.querySelector(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  return (el.textContent ?? "").trim();
};
const rows = (page: Page) => Array.from(page.document.querySelectorAll("#participants tr[data-row]"));
const click = (page: Page, el: Element | null) => (el as any).dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));

function type(page: Page, input: Element | null, value: string) {
  const el = input as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new page.window.Event("input", { bubbles: true }));
}

function rowInput(page: Page, rowIndex: number, field: string, hop?: number): Element | null {
  const hopSel = hop === undefined ? "" : `[data-hop="${hop}"]`;
  return rows(page)[rowIndex].querySelector(`[data-field="${field}"]${hopSel}`);
}

async function importCsv(page: Page, csv: string) {
  const input = page.document.querySelector("#import-file") as any;
  const file = new page.window.File([csv], "scenario.csv", { type: "text/csv" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new page.window.Event("change", { bubbles: true }));
  // The page reads the file asynchronously; wait for the import to land.
  for (let i = 0; i < 50 && page.document.body.dataset.importing !== "done"; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** n self-filled seeds ($33k each), as a scenario CSV. */
const selfFillCsv = (n: number) =>
  scenario.scenarioToCsv(Array.from({ length: n }, (_, i) => scenario.selfFill({ ...scenario.emptyRow(), name: `P${i + 1}` })));

describe("crowdfund model UI (jsdom end-to-end)", function () {
  // WHY: a fresh file shared with the team must open empty (no prospective-commit data
  //      ships in the repo) and show the honest outcome for zero demand.
  it("opens empty and reports refund mode", function () {
    const page = open();
    expect(rows(page)).to.have.length(0);
    expect(text(page, '[data-summary="outcome"]')).to.match(/Refund mode/);
    expect(text(page, '[data-summary="total-committed"]')).to.equal("$0.00");
  });

  // WHY: the core loop: add a participant, enter per-hop commits, see results update live.
  it("adds a participant and self-fills them to $33k across three hops", function () {
    const page = open();
    click(page, page.document.querySelector("#add-row"));
    type(page, rowInput(page, 0, "name"), "Alice");
    click(page, rows(page)[0].querySelector('[data-action="self-fill"]'));

    expect((rowInput(page, 0, "commit", 0) as HTMLInputElement).value).to.equal("15000");
    expect((rowInput(page, 0, "commit", 1) as HTMLInputElement).value).to.equal("12000");
    expect((rowInput(page, 0, "invites", 1) as HTMLInputElement).value).to.equal("3");
    expect((rowInput(page, 0, "invites", 2) as HTMLInputElement).value).to.equal("6");
    expect(text(page, '#participants tr[data-row] [data-out="committed"]')).to.equal("$33,000.00");
    expect(text(page, '[data-summary="total-committed"]')).to.equal("$33,000.00");
  });

  // WHY: results must update on every keystroke without rebuilding the inputs, or the
  //      cursor would jump out of the field being typed in.
  it("recomputes while typing without stealing focus", function () {
    const page = open();
    click(page, page.document.querySelector("#add-row"));
    const input = rowInput(page, 0, "commit", 0) as HTMLInputElement;
    input.focus();
    type(page, input, "20000");
    expect(page.document.activeElement).to.equal(input);
    expect(text(page, '[data-summary="total-committed"]')).to.equal("$20,000.00");
    expect(text(page, '[data-summary="capped-demand"]')).to.equal("$15,000.00");
  });

  // WHY: 40 self-fillers oversubscribe every hop at BASE_SALE; the page must show the
  //      contract's numbers (golden values from engine.test.ts) in the summary, hop table and rows.
  it("shows hop fills and pro-rata allocations for an imported scenario", async function () {
    const page = open();
    await importCsv(page, selfFillCsv(40));
    expect(rows(page)).to.have.length(40);

    expect(text(page, '[data-summary="outcome"]')).to.match(/Success/);
    expect(text(page, '[data-summary="sale-size"]')).to.equal("$1,200,000.00");
    expect(text(page, '[data-summary="allocated"]')).to.equal("1,200,000.00 ARM");
    expect(text(page, '[data-summary="refunds"]')).to.equal("$120,000.00");

    expect(text(page, '#hop-table tr[data-hop="0"] [data-col="ceiling"]')).to.equal("$564,000.00");
    expect(text(page, '#hop-table tr[data-hop="0"] [data-col="allocated"]')).to.equal("$564,000.00");
    expect(text(page, '#hop-table tr[data-hop="0"] [data-col="fill"]')).to.equal("106.3%");
    expect(text(page, '#hop-table tr[data-hop="1"] [data-col="accepted"]')).to.equal("95.0%");
    expect(text(page, '#hop-table tr[data-hop="2"] [data-col="ceiling"]')).to.equal("$180,000.00");

    const first = rows(page)[0];
    expect(first.querySelector('[data-out="arm"]')!.textContent).to.equal("30,000.00");
    expect(first.querySelector('[data-out="refund"]')!.textContent).to.equal("$3,000.00");
    expect(first.querySelector('[data-out="accepted"][data-hop="0"]')!.textContent).to.contain("$14,100.00");
  });

  // WHY: the include toggle is how the team models "maybe" commits.
  it("excludes unchecked participants from the model", async function () {
    const page = open();
    await importCsv(page, selfFillCsv(2));
    const include = rowInput(page, 1, "include") as HTMLInputElement;
    include.checked = false;
    include.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    expect(text(page, '[data-summary="total-committed"]')).to.equal("$33,000.00");
    expect(rows(page)[1].querySelector('[data-out="arm"]')!.textContent).to.equal("—");
  });

  // WHY: inputs the contract would reject must be visible, not silently modeled.
  it("lists validation issues", function () {
    const page = open();
    click(page, page.document.querySelector("#add-row"));
    type(page, rowInput(page, 0, "commit", 0), "5");
    const issues = Array.from(page.document.querySelectorAll("#issues li")).map((li) => li.textContent);
    expect(issues).to.have.length(1);
    expect(issues[0]).to.match(/minimum commit/);
  });

  // WHY: row actions rebuild the table; totals must follow the structural change.
  it("duplicates and removes rows", function () {
    const page = open();
    click(page, page.document.querySelector("#add-row"));
    type(page, rowInput(page, 0, "commit", 0), "1000");
    click(page, rows(page)[0].querySelector('[data-action="duplicate"]'));
    expect(rows(page)).to.have.length(2);
    expect(text(page, '[data-summary="total-committed"]')).to.equal("$2,000.00");
    click(page, rows(page)[0].querySelector('[data-action="remove"]'));
    expect(rows(page)).to.have.length(1);
    expect(text(page, '[data-summary="total-committed"]')).to.equal("$1,000.00");
  });

  // WHY: autosave is what makes the file usable across sessions without a backend.
  it("restores the scenario from localStorage on reload", function () {
    const first = open();
    click(first, first.document.querySelector("#add-row"));
    type(first, rowInput(first, 0, "name"), "Bob");
    type(first, rowInput(first, 0, "commit", 1), "4000");
    const saved = first.window.localStorage.getItem(STORAGE_KEY);

    const reloaded = open(saved);
    expect(rows(reloaded)).to.have.length(1);
    expect((rowInput(reloaded, 0, "name") as HTMLInputElement).value).to.equal("Bob");
    expect(text(reloaded, '[data-summary="total-committed"]')).to.equal("$4,000.00");
  });

  // WHY: CSV is how scenarios move between teammates; export must re-import losslessly.
  it("exports the scenario and results as CSV", async function () {
    const page = open();
    const csv = selfFillCsv(3);
    await importCsv(page, csv);

    click(page, page.document.querySelector("#export-scenario"));
    expect(page.downloads[0].filename).to.equal("crowdfund-scenario.csv");
    expect(await page.downloads[0].text).to.equal(csv);

    click(page, page.document.querySelector("#export-results"));
    expect(page.downloads[1].filename).to.equal("crowdfund-results.csv");
    expect((await page.downloads[1].text).split("\n")[0]).to.match(/^name,committed_hop0/);
  });

  // WHY: a bad import must never wipe the scenario the user has been building.
  it("reports a malformed CSV without replacing the current rows", async function () {
    const page = open();
    click(page, page.document.querySelector("#add-row"));
    await importCsv(page, "foo,bar\n1,2\n");
    expect(rows(page)).to.have.length(1);
    expect(text(page, "#import-status")).to.match(/header/);
  });
});
