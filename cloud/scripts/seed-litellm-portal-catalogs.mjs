// One-shot migration: carry the existing human zh-CN/en translations (keyed by
// SOURCE TEXT in the legacy i18n/messages/{locale}.ts maps) into the freshly
// extracted id-keyed .po catalogs (keyed by macro hash id, with the source
// text in msgid). For each .po entry whose msgid equals a legacy source-text
// key, write the legacy translation into msgstr. No translation is lost; any
// .po entry with no legacy match is left as-is for human follow-up.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../src/litellm-portal/i18n/", import.meta.url);

async function loadLegacyMap(locale) {
  const mod = await import(new URL(`messages/${locale}.ts`, root).href);
  return mod.default;
}

function patchPo(poText, legacyMap) {
  // .po blocks: optional comments, msgid "<src>", msgstr "<value>"
  return poText.replace(
    /(msgid\s+("(?:[^"\\]|\\.)*"(?:\n"(?:[^"\\]|\\.)*")*)\nmsgstr\s+)("(?:[^"\\]|\\.)*"(?:\n"(?:[^"\\]|\\.)*")*)/g,
    (whole, _head, rawMsgid, _rawMsgstr) => {
      const src = JSON.parse(`[${rawMsgid.replace(/"\n"/g, '","')}]`).join("");
      if (src.length > 0 && Object.prototype.hasOwnProperty.call(legacyMap, src)) {
        const translated = legacyMap[src];
        return whole.replace(/msgstr\s+"(?:[^"\\]|\\.)*"(?:\n"(?:[^"\\]|\\.)*")*/,
          `msgstr ${JSON.stringify(translated)}`);
      }
      return whole;
    },
  );
}

for (const locale of ["zh-CN", "en"]) {
  const poUrl = new URL(`locales/${locale}/messages.po`, root);
  const poPath = fileURLToPath(poUrl);
  const legacy = await loadLegacyMap(locale);
  const patched = patchPo(readFileSync(poPath, "utf8"), legacy);
  writeFileSync(poPath, patched);
  console.log(`seeded ${locale}: ${Object.keys(legacy).length} legacy entries applied`);
}
