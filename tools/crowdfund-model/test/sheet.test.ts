// ABOUTME: Tests the generated Google Sheet script (sheet/Code.gs): live =ARMADA_* formulas on sheet-shaped input
// ABOUTME: and the setup menu, run against the generated artifact itself with a recording SpreadsheetApp fake.

import { expect } from "chai";
import * as fs from "fs";
import { buildSheetScript, SHEET_SCRIPT_PATH } from "../modelSource";

const SHEET_GLOBALS = [
  "ARMADA_RESULTS", "ARMADA_SUMMARY", "ARMADA_HOPS", "ARMADA_ISSUES", "ARMADA_SELFTEST",
  "onOpen", "armadaSetUpSheets", "armadaRunSelfTest",
];

/** A minimal recording stand-in for Apps Script's SpreadsheetApp (only what the setup uses). */
function fakeSpreadsheetApp() {
  const sheets = new Map<string, any>();
  const menus: { name: string; items: [string, string][] }[] = [];
  const alerts: string[] = [];
  let inserts = 0;

  function makeRange(sheet: any, a1: string) {
    const range: any = {};
    const record = (key: string) => (value: any) => {
      sheet.cells[`${a1}:${key}`] = value;
      return range;
    };
    range.setValues = record("values");
    range.setFormula = record("formula");
    range.setNumberFormat = record("format");
    range.setFontWeight = record("weight");
    range.setDataValidation = record("validation");
    return range;
  }

  function makeSheet(name: string) {
    const sheet: any = { name, cells: {} as Record<string, any>, frozenRows: 0 };
    sheet.getRange = (a1: string) => makeRange(sheet, a1);
    sheet.setFrozenRows = (n: number) => { sheet.frozenRows = n; };
    return sheet;
  }

  const spreadsheet = {
    getSheetByName: (name: string) => sheets.get(name) ?? null,
    insertSheet: (name: string) => {
      inserts++;
      const sheet = makeSheet(name);
      sheets.set(name, sheet);
      return sheet;
    },
  };

  const app = {
    getActiveSpreadsheet: () => spreadsheet,
    newDataValidation: () => {
      const rule: any = {};
      rule.requireValueInList = (values: string[], dropdown: boolean) => { rule.list = values; rule.dropdown = dropdown; return rule; };
      rule.setAllowInvalid = (allow: boolean) => { rule.allowInvalid = allow; return rule; };
      rule.build = () => ({ list: rule.list, allowInvalid: rule.allowInvalid });
      return rule;
    },
    getUi: () => ({
      createMenu: (name: string) => {
        const menu = { name, items: [] as [string, string][] };
        const builder: any = {
          addItem: (label: string, fn: string) => { menu.items.push([label, fn]); return builder; },
          addToUi: () => { menus.push(menu); },
        };
        return builder;
      },
      alert: (message: string) => { alerts.push(message); },
    }),
  };
  return { app, sheets, menus, alerts, inserts: () => inserts };
}

/** Evaluates the generated Code.gs the way Apps Script does: one global scope, SpreadsheetApp injected. */
function loadSheetScript(spreadsheetApp: any = fakeSpreadsheetApp().app): Record<string, any> {
  const body = `${buildSheetScript()}\nreturn { ${SHEET_GLOBALS.join(", ")} };`;
  return new Function("SpreadsheetApp", body)(spreadsheetApp);
}

const sheet = loadSheetScript();

/** One sheet row in the Inputs column order: name, include, hop0, hop1, hop1 invites, hop2, hop2 invites. */
type Cell = string | number | boolean;
const selfFilledRow = (name: string): Cell[] => [name, "", 15000, 12000, 3, 6000, 6];
const blankRow = (): Cell[] => ["", "", "", "", "", "", ""];
const fortySelfFilled = () => Array.from({ length: 40 }, (_, i) => selfFilledRow(`P${i + 1}`));

const summaryValue = (summary: Cell[][], label: string) => {
  const row = summary.find((r) => r[0] === label);
  if (!row) throw new Error(`no summary row ${label}`);
  return row[1];
};

describe("crowdfund model Google Sheet script", function () {
  // WHY: the pasted file is generated; a stale committed copy would put old math in the shared sheet.
  it("matches the committed sheet/Code.gs (run `npm run crowdfund-model:build-sheet`)", function () {
    expect(fs.readFileSync(SHEET_SCRIPT_PATH, "utf8")).to.equal(buildSheetScript());
  });

  // WHY: Apps Script checks syntax on save with an Esprima-based parser that predates BigInt
  //      literals (`1000000n` → "ParseError: Unexpected token ILLEGAL"). Node runs the file
  //      fine, so only a parse with Esprima catches syntax the sheet editor will reject.
  it("parses with Esprima, as the Apps Script editor does on save", function () {
    const esprima = require("esprima");
    expect(() => esprima.parseScript(buildSheetScript())).not.to.throw();
  });

  describe("ARMADA_RESULTS", function () {
    // WHY: results spill beside the inputs, so output row k must belong to input row k,
    //      including the many blank rows an open-ended range like A2:G passes in.
    it("returns one row per input row with blanks for blank rows", function () {
      const out = sheet.ARMADA_RESULTS([...fortySelfFilled(), blankRow(), blankRow()]);
      expect(out).to.have.length(42);
      expect(out[0]).to.deep.equal([33000, 14100, 11400, 4500, 30000, 3000, ""]);
      expect(out[41]).to.deep.equal(["", "", "", "", "", "", ""]);
    });

    // WHY: golden values from engine.test.ts — a pro-rated hop must reach the cell at full precision.
    it("returns exact 6-decimal amounts from pro-rata floor division", function () {
      const rows = fortySelfFilled();
      rows[0] = ["P1", "", 10000, 12000, 3, 6000, 6]; // hop-0 demand $595k vs $564k ceiling
      const out = sheet.ARMADA_RESULTS(rows);
      expect(out[1].slice(1, 4)).to.deep.equal([14218.487394, 11400, 4500]);
      expect(out[1][4]).to.equal(30118.487394);
    });

    // WHY: sheet cells arrive as numbers, booleans and strings; "no" and an unticked checkbox
    //      both exclude a row, a hop the participant doesn't hold stays blank.
    it("reads mixed cell types and marks excluded rows", function () {
      const out = sheet.ARMADA_RESULTS([
        ["Ann", true, "15,000", "", "", "", ""],
        ["Bob", "no", 15000, "", "", "", ""],
        ["Cy", false, 15000, "", "", "", ""],
      ]);
      expect(out[0].slice(0, 4)).to.deep.equal([15000, 0, "", ""]);
      expect(out[1]).to.deep.equal(["", "", "", "", "", "", "excluded"]);
      expect(out[2]).to.deep.equal(["", "", "", "", "", "", "excluded"]);
    });

    // WHY: per-row problems belong next to the row so whoever typed them sees them.
    it("reports a row's issues in its last column", function () {
      const out = sheet.ARMADA_RESULTS([["Typo", "", 5, "", "", "", ""], ["Frac", "", "", 4000, 3.5, "", ""]]);
      expect(out[0][6]).to.match(/hop 0: Below the \$10\.00 minimum/);
      expect(out[1][6]).to.match(/hop1_invites must be a whole number/);
    });

    // WHY: Sheets passes a lone value (not a 2D array) when the range is a single cell.
    it("accepts a single-cell range", function () {
      expect(sheet.ARMADA_RESULTS("")).to.deep.equal([["", "", "", "", "", "", ""]]);
    });
  });

  describe("ARMADA_SUMMARY", function () {
    // WHY: the summary is the headline the team reads; it must carry the contract's outcome.
    it("summarizes a successful oversubscribed sale", function () {
      const summary = sheet.ARMADA_SUMMARY(fortySelfFilled());
      expect(summaryValue(summary, "Outcome")).to.equal("Success: base sale");
      expect(summaryValue(summary, "Sale size (USDC)")).to.equal(1200000);
      expect(summaryValue(summary, "ARM allocated")).to.equal(1200000);
      expect(summaryValue(summary, "USDC refunded")).to.equal(120000);
      expect(summaryValue(summary, "Net proceeds to treasury (USDC)")).to.equal(1199999.99988);
      expect(summaryValue(summary, "Hop nodes")).to.equal(120);
    });

    // WHY: both refund exits must be named, since they call for different fixes.
    it("names the refund reason", function () {
      const summary = sheet.ARMADA_SUMMARY(Array.from({ length: 67 }, (_, i) => [`S${i}`, "", 15000, "", "", "", ""]));
      expect(summaryValue(summary, "Outcome")).to.equal("Refund mode");
      expect(summaryValue(summary, "Refund reason")).to.match(/hop ceilings only allocate/);
      expect(summaryValue(summary, "Hop table basis")).to.equal("finalize() waterfall");
    });
  });

  describe("ARMADA_HOPS", function () {
    // WHY: the hop table mirrors the Details page; ratios are fractions so the sheet formats them as %.
    it("returns the hop table with header, hop rows and total", function () {
      const hops = sheet.ARMADA_HOPS(fortySelfFilled());
      expect(hops).to.have.length(5);
      expect(hops[0][0]).to.equal("Hop");
      expect(hops[1]).to.deep.equal(["Hop 0 (seeds)", 0.47, 40, 600000, 600000, 564000, 564000, 600000 / 564000, 0.94, 0]);
      expect(hops[3][9]).to.equal("");
      expect(hops[4].slice(0, 3)).to.deep.equal(["Total", 1, 120]);
    });
  });

  describe("ARMADA_ISSUES", function () {
    // WHY: aggregate issues (seed cap, invite supply) only appear here; rows are numbered as
    //      sheet rows so a teammate can find them.
    it("lists issues with sheet row numbers", function () {
      const issues = sheet.ARMADA_ISSUES([selfFilledRow("A"), ["Typo", "", 5, "", "", "", ""]], 2);
      expect(issues).to.have.length(1);
      expect(issues[0].slice(0, 2)).to.deep.equal(["error", "Row 3 (Typo) · hop 0"]);
    });

    it("reports no issues explicitly", function () {
      expect(sheet.ARMADA_ISSUES([selfFilledRow("A")])).to.deep.equal([["ok", "", "No issues"]]);
    });
  });

  // WHY: the in-sheet smoke test: proves the Apps Script runtime runs the BigInt engine and
  //      reproduces the golden vectors before anyone trusts the numbers.
  it("ARMADA_SELFTEST passes", function () {
    expect(sheet.ARMADA_SELFTEST()).to.match(/^OK/);
  });

  describe("setup menu", function () {
    // WHY: setup makes deployment two steps (paste, click); it must wire the formulas to the
    //      Inputs columns and be safe to run again on a sheet that already has data.
    it("creates the Inputs and Model tabs with headers and live formulas, idempotently", function () {
      const fake = fakeSpreadsheetApp();
      const script = loadSheetScript(fake.app);
      script.armadaSetUpSheets();
      script.armadaSetUpSheets();
      expect(fake.inserts()).to.equal(2);

      const inputs = fake.sheets.get("Inputs");
      expect(inputs.cells["A1:G1:values"]).to.deep.equal([
        ["name", "include", "hop0_commit", "hop1_commit", "hop1_invites", "hop2_commit", "hop2_invites"],
      ]);
      expect(inputs.cells["I2:formula"]).to.equal("=ARMADA_RESULTS(A2:G)");
      expect(inputs.cells["B2:B:validation"]).to.deep.equal({ list: ["yes", "no"], allowInvalid: false });
      expect(inputs.frozenRows).to.equal(1);

      const model = fake.sheets.get("Model");
      expect(model.cells["A1:formula"]).to.equal("=ARMADA_SUMMARY(Inputs!A2:G)");
      expect(model.cells["A17:formula"]).to.equal("=ARMADA_HOPS(Inputs!A2:G)");
      expect(model.cells["A24:formula"]).to.equal("=ARMADA_ISSUES(Inputs!A2:G, 2)");
    });

    it("adds the Armada menu on open and alerts the self-test result", function () {
      const fake = fakeSpreadsheetApp();
      const script = loadSheetScript(fake.app);
      script.onOpen();
      expect(fake.menus[0].name).to.equal("Armada");
      expect(fake.menus[0].items.map((i) => i[1])).to.deep.equal(["armadaSetUpSheets", "armadaRunSelfTest"]);
      script.armadaRunSelfTest();
      expect(fake.alerts[0]).to.match(/^OK/);
    });
  });
});
