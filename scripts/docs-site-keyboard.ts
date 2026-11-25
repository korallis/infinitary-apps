import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  headingId,
  pagesFolder,
  SCOPE_WORD_KEYS,
  type SiteWord,
  SOURCE_LANGUAGE,
  shippedLanguages,
  wordsOf,
} from "../docs-site/languages.ts";
import { staleGeneratedFile } from "./github-errors.ts";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";

/**
 * The docs site's Keyboard page (docs/docs-site.md, "Generated pages"),
 * written from the app's own command list so it never says a key the app
 * does not have: every command a person can run from the keyboard, with the
 * keys Keyboard settings gives it in each preset, on a Mac and on Linux or
 * Windows, which share the Ctrl keys (desktopConventions). The
 * keys are the window's own resolution (`resolveBindings`) of a preset with
 * nothing changed, the app's own panels' commands included, so a key a
 * preset suggests that another command already holds is left out here as it
 * is in the app.
 *
 * Each shipped language gets its own page (docs/docs-site.md, "Languages"):
 * the commands read as the app's catalog words them in that language, and
 * the page's own sentences come from the language's words file.
 *
 *   node scripts/docs-site-keyboard.ts           writes every language's page
 *   node scripts/docs-site-keyboard.ts --check   fails when a page is out of step
 */

export function keyboardPagePath(tag: string): string {
  return relative(REPO_ROOT, join(pagesFolder(tag), "keyboard.mdx"));
}

/** The app's own panels whose commands read as the window's, in the order the app adds them. */
const OWN_PANELS = ["src/panels/now/manifest.json", "src/panels/knowledge/manifest.json"];

type Chord = { key: string; meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean };
type Binding = Chord & { second?: Chord; when?: "not-typing" };
type System = "mac" | "ctrl";
type Scope = "window" | "message-field" | "main-message";
type PanelCommand = {
  id: `panel:${string}`;
  label: string;
  panel: string;
  keys: Binding[];
  words?: string[];
  own?: true;
};
type ManifestCommand = { id: string; label: string; key?: string; words?: string[] };

export type KeyboardModules = {
  keyboard: {
    KEYBOARD_COMMANDS: Record<string, { label: string; scope: Scope; section?: string }>;
    allCommandIds: (panels: readonly PanelCommand[]) => string[];
    isCatalogCommand: (id: string) => boolean;
    bindingLabel: (binding: Binding, system: System) => string;
    keysOf: (bindings: unknown, id: string) => readonly Binding[];
    commandEntry: (id: string, panels: readonly PanelCommand[]) => { label: string } | undefined;
  };
  keymap: {
    presetKeymap: (preset: string) => unknown;
    resolveBindings: (saved: unknown, panels: readonly PanelCommand[], system: System) => unknown;
    SCOPE_WORDS: Record<Scope, string>;
  };
  presets: {
    PRESET_IDS: readonly string[];
    PRESET_LABELS: Record<string, string>;
    NEW_PROFILE_PRESET: string;
  };
  panelCards: { parseSuggestedKey: (text: string) => Chord | null };
  /** The process's language, so a page's commands read in its language; English when absent. */
  current?: { inLanguage: <T>(tag: string, word: () => T) => T };
};

/** The app's own panels' commands, as the window installs them (`panelCommandsOf`). */
export function ownPanelCommands(modules: KeyboardModules): PanelCommand[] {
  return OWN_PANELS.flatMap((path) => {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8")) as {
      title: string;
      commands?: ManifestCommand[];
    };
    const panel = path.split("/").at(-2) ?? "";
    return (manifest.commands ?? []).map((command): PanelCommand => {
      const chord = command.key === undefined ? null : modules.panelCards.parseSuggestedKey(command.key);
      return {
        id: `panel:${panel}/${command.id}` as const,
        label: command.label,
        panel: manifest.title,
        keys: chord ? [chord] : [],
        ...(command.words?.length ? { words: [...command.words] } : {}),
        own: true,
      };
    });
  });
}

/** One row of the page: a command, where it works, and its keys on each system, each drawn as key caps. */
export type KeyRow = { id: string; label: string; scope: Scope; mac: string[]; linux: string[] };

/**
 * Every command a preset gives a person, in the order Keyboard settings
 * lists them. A command that acts in a Settings section some builds do not
 * offer (`section`) is left out, as those builds leave it out.
 */
export function presetRows(modules: KeyboardModules, preset: string, notTyping = " when not typing"): KeyRow[] {
  const panels = ownPanelCommands(modules);
  const saved = modules.keymap.presetKeymap(preset);
  const mac = modules.keymap.resolveBindings(saved, panels, "mac");
  const linux = modules.keymap.resolveBindings(saved, panels, "ctrl");
  const words = (binding: Binding, system: System) =>
    `<kbd>${cell(modules.keyboard.bindingLabel(binding, system))}</kbd>` +
    (binding.when === "not-typing" ? notTyping : "");
  return modules.keyboard.allCommandIds(panels).flatMap((id): KeyRow[] => {
    const catalog = modules.keyboard.isCatalogCommand(id)
      ? modules.keyboard.KEYBOARD_COMMANDS[id]
      : undefined;
    if (catalog?.section) return [];
    const label = modules.keyboard.commandEntry(id, panels)?.label ?? id;
    return [
      {
        id,
        label,
        scope: catalog?.scope ?? "window",
        mac: modules.keyboard.keysOf(mac, id).map((binding) => words(binding, "mac")),
        linux: modules.keyboard.keysOf(linux, id).map((binding) => words(binding, "ctrl")),
      },
    ];
  });
}

/** Text inside a table cell, with nothing Markdown or HTML would read as its own. */
function cell(text: string): string {
  return text.replace(/[^\p{L}\p{N}\p{S} ’'.,()+=-]|[\\|<>&`^~{}[\]*_#]/gu, (character) => `&#${character.codePointAt(0)};`);
}

function keys(list: string[]): string {
  return list.length === 0 ? "—" : list.join(", ");
}

function table(rows: KeyRow[], words: Partial<Record<SiteWord, string>>): string[] {
  return [
    `| ${words["keyboard.column.command"]} | ${words["keyboard.column.mac"]} | ${words["keyboard.column.linux"]} |`,
    "| --- | --- | --- |",
    ...rows.map((row) => `| ${cell(row.label)} | ${keys(row.mac)} | ${keys(row.linux)} |`),
  ];
}

/**
 * The whole page in one language, from the app's modules. A translated
 * page's headings keep the English page's ids, so a link to one works in
 * every language.
 */
export function keyboardPage(modules: KeyboardModules, tag: string = SOURCE_LANGUAGE): string {
  if (tag !== SOURCE_LANGUAGE && !modules.current) {
    throw new Error(`The Keyboard page in ${tag} needs the app's language module`);
  }
  return modules.current ? modules.current.inLanguage(tag, () => pageIn(modules, tag)) : pageIn(modules, tag);
}

function pageIn(modules: KeyboardModules, tag: string): string {
  const english = wordsOf(SOURCE_LANGUAGE);
  const words = wordsOf(tag);
  const heading = (key: SiteWord) =>
    tag === SOURCE_LANGUAGE ? `## ${words[key]}` : `## ${words[key]} {#${headingId(english[key] ?? "")}}`;
  const scopeWords = (scope: Scope) =>
    tag === SOURCE_LANGUAGE ? modules.keymap.SCOPE_WORDS[scope] : (words[SCOPE_WORD_KEYS[scope]] ?? "");
  const notTyping = ` ${words["keyboard.notTyping"]}`;
  const { PRESET_IDS, PRESET_LABELS, NEW_PROFILE_PRESET } = modules.presets;
  const ordered = [NEW_PROFILE_PRESET, ...PRESET_IDS.filter((id) => id !== NEW_PROFILE_PRESET)];
  const scopes: Scope[] = ["window", "message-field", "main-message"];
  const tabs = ordered.flatMap((preset) => {
    const rows = presetRows(modules, preset, notTyping);
    const sections = scopes.flatMap((scope) => {
      const here = rows.filter((row) => row.scope === scope);
      return here.length === 0 ? [] : ["", `**${cell(scopeWords(scope))}**`, "", ...table(here, words)];
    });
    return [`<TabItem label="${PRESET_LABELS[preset]}">`, ...sections, "", "</TabItem>"];
  });
  const presetNames = ordered.map((id) => PRESET_LABELS[id]).join(words["keyboard.separator"]);
  const fill = (key: SiteWord) =>
    (words[key] ?? "")
      .replace("{presets}", presetNames)
      .replace("{preset}", PRESET_LABELS[NEW_PROFILE_PRESET] ?? NEW_PROFILE_PRESET);
  return [
    "---",
    `title: ${words["keyboard.title"]}`,
    `description: ${words["keyboard.description"]}`,
    "---",
    "",
    "{/* Written by node scripts/docs-site-keyboard.ts from the app's own command list. Do not edit by hand. */}",
    "",
    "import { TabItem, Tabs } from '@astrojs/starlight/components';",
    "",
    fill("keyboard.intro"),
    "",
    heading("keyboard.search.heading"),
    "",
    fill("keyboard.search"),
    "",
    heading("keyboard.presets.heading"),
    "",
    fill("keyboard.presets"),
    "",
    heading("keyboard.change.heading"),
    "",
    fill("keyboard.change"),
    "",
    heading("keyboard.every.heading"),
    "",
    fill("keyboard.every"),
    "",
    "<Tabs syncKey=\"keyboard-preset\">",
    ...tabs,
    "</Tabs>",
    "",
  ].join("\n");
}

/** Loads the app's keyboard modules the way the app's tests do. */
export async function loadKeyboardModules(): Promise<{ modules: KeyboardModules; close: () => Promise<void> }> {
  const runner = await openModuleRunner();
  const modules: KeyboardModules = {
    keyboard: await runner.import("/src/shared/keyboard.ts"),
    keymap: await runner.import("/src/shared/keymap.ts"),
    presets: await runner.import("/src/shared/keyPresets.ts"),
    panelCards: await runner.import("/src/shared/plugins/panelCards.ts"),
    current: await runner.import("/src/shared/i18n/current.ts"),
  };
  return { modules, close: runner.close };
}

if (process.argv[1]?.endsWith("docs-site-keyboard.ts")) {
  const { modules, close } = await loadKeyboardModules();
  const pages = shippedLanguages().map((tag) => ({ path: keyboardPagePath(tag), page: keyboardPage(modules, tag) }));
  await close();
  for (const { path, page } of pages) {
    const full = join(REPO_ROOT, path);
    if (!process.argv.includes("--check")) writeFileSync(full, page);
    else if (!existsSync(full) || readFileSync(full, "utf8") !== page) throw staleGeneratedFile(path, "node scripts/docs-site-keyboard.ts");
  }
}
