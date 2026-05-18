import { describe, expect, it } from "vitest";
import linguiConfig from "../../../lingui.config";

describe("lingui.config", () => {
  it("targets the compiled token-array runtime with id-keyed catalogs", () => {
    expect(linguiConfig.locales).toEqual(["zh-CN", "en"]);
    expect(linguiConfig.sourceLocale).toBe("zh-CN");
    expect(linguiConfig.compileNamespace).toBe("es");
    const cat = linguiConfig.catalogs?.[0];
    expect(cat?.path).toBe("src/litellm-portal/i18n/locales/{locale}/messages");
    expect(cat?.include).toEqual(["src/litellm-portal"]);
  });
});
