/**
 * 页面字典的取词函数（界面只做中文，D-A3）：每个页面一份字典，用它生成自己的 t()。
 *
 *   export const zh = { "mcp.saved": "已生效：「{name}」" } as const;
 *   export const t = createTranslator(zh);
 *   t("mcp.saved", { name: "demo" }); // → 已生效：「demo」
 *
 * 模板参数写成 {name}；没给的参数原样留着，方便一眼看出漏了什么。
 */
export function createTranslator<K extends string>(
  dict: Readonly<Record<K, string>>,
): (key: K, values?: Record<string, unknown>) => string {
  return (key, values) => {
    let text: string = dict[key];
    if (values !== undefined) {
      for (const [name, value] of Object.entries(values)) text = text.replaceAll("{" + name + "}", String(value));
    }
    return text;
  };
}
