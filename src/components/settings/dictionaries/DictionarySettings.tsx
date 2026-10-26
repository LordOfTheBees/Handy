import React, { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { commands, type Dictionary, type DictionaryEntry } from "@/bindings";
import { useSettings } from "@/hooks/useSettings";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { Switch } from "../../ui/Switch";
import { Textarea } from "../../ui/Textarea";
import { parseTermList } from "./importTerms";

const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
const keyOf = (value: string) => value.toLowerCase();

function findConflicts(
  dictionaries: Dictionary[],
  displayName: (dictionary: Dictionary) => string,
) {
  const first = new Map<string, { term: string; dictionary: string }>();
  const conflicts: string[] = [];
  for (const dictionary of dictionaries.filter((item) => item.enabled)) {
    for (const entry of dictionary.entries) {
      for (const variant of entry.variants) {
        const key = keyOf(variant);
        const previous = first.get(key);
        if (!previous) {
          first.set(key, {
            term: entry.term,
            dictionary: displayName(dictionary),
          });
        } else if (keyOf(previous.term) !== keyOf(entry.term)) {
          conflicts.push(
            `${variant}: ${previous.term} (${previous.dictionary}) → ${entry.term} (${displayName(dictionary)})`,
          );
        }
      }
    }
  }
  return conflicts;
}

export const DictionarySettings: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { getSetting, refreshSettings, isLoading } = useSettings();
  const dictionaries = getSetting("dictionaries") ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [search, setSearch] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [termDraft, setTermDraft] = useState("");
  const [variantsDraft, setVariantsDraft] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [saving, setSaving] = useState(false);
  const selected =
    dictionaries.find((item) => item.id === selectedId) ?? dictionaries[0];
  const displayName = (dictionary: Dictionary) =>
    dictionary.id === "general" && dictionary.name === "General"
      ? t("settings.dictionaries.generalName")
      : dictionary.name;
  const preview = useMemo(
    () =>
      parseTermList(
        bulkText,
        selected?.entries.map((entry) => entry.term) ?? [],
      ),
    [bulkText, selected],
  );
  const conflicts = findConflicts(dictionaries, displayName);

  useEffect(() => {
    setNameDraft(selected ? displayName(selected) : "");
    setEditingIndex(null);
    setSearch("");
    setBulkText("");
  }, [selected?.id, i18n.language]);

  const save = async (next: Dictionary[]): Promise<boolean> => {
    setSaving(true);
    try {
      const result = await commands.updateDictionaries(next);
      if (result.status === "error") throw new Error(result.error);
      await refreshSettings();
      return true;
    } catch (error) {
      console.error("Failed to save dictionaries:", error);
      toast.error(t("settings.dictionaries.saveError"));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const replaceSelected = (replacement: Dictionary) =>
    save(
      dictionaries.map((item) =>
        item.id === replacement.id ? replacement : item,
      ),
    );

  const createDictionary = async () => {
    const name = normalize(newName);
    if (
      !name ||
      Array.from(name).length > 80 ||
      dictionaries.some(
        (item) =>
          keyOf(item.name) === keyOf(name) ||
          keyOf(displayName(item)) === keyOf(name),
      )
    ) {
      toast.error(t("settings.dictionaries.invalidName"));
      return;
    }
    const id = `dict_${crypto.randomUUID().replace(/-/g, "")}`;
    if (
      await save([...dictionaries, { id, name, enabled: true, entries: [] }])
    ) {
      setSelectedId(id);
      setNewName("");
    }
  };

  const renameDictionary = async () => {
    if (!selected) return;
    const name = normalize(nameDraft);
    if (
      !name ||
      Array.from(name).length > 80 ||
      dictionaries.some(
        (item) =>
          item.id !== selected.id &&
          (keyOf(item.name) === keyOf(name) ||
            keyOf(displayName(item)) === keyOf(name)),
      )
    ) {
      toast.error(t("settings.dictionaries.invalidName"));
      return;
    }
    await replaceSelected({ ...selected, name });
  };

  const deleteDictionary = async () => {
    if (
      !selected ||
      !window.confirm(
        t("settings.dictionaries.deleteConfirm", {
          name: displayName(selected),
        }),
      )
    )
      return;
    if (await save(dictionaries.filter((item) => item.id !== selected.id))) {
      setSelectedId(null);
    }
  };

  const moveDictionary = async (offset: -1 | 1) => {
    if (!selected) return;
    const current = dictionaries.findIndex((item) => item.id === selected.id);
    const target = current + offset;
    if (target < 0 || target >= dictionaries.length) return;
    const reordered = [...dictionaries];
    [reordered[current], reordered[target]] = [
      reordered[target],
      reordered[current],
    ];
    await save(reordered);
  };

  const beginEntry = (index: number) => {
    setEditingIndex(index);
    const entry = selected?.entries[index];
    setTermDraft(entry?.term ?? "");
    setVariantsDraft(entry?.variants.join("\n") ?? "");
  };

  const saveEntry = async () => {
    if (!selected || editingIndex === null) return;
    const term = normalize(termDraft);
    const variants = variantsDraft
      .split(/\r?\n/)
      .map(normalize)
      .filter(Boolean);
    const otherEntries = selected.entries.filter(
      (_, index) => index !== editingIndex,
    );
    const otherTerms = new Set(otherEntries.map((entry) => keyOf(entry.term)));
    const otherVariants = new Set(
      otherEntries.flatMap((entry) => entry.variants.map(keyOf)),
    );
    if (
      !term ||
      Array.from(term).length > 100 ||
      otherTerms.has(keyOf(term)) ||
      variants.some(
        (value) =>
          Array.from(value).length > 100 || otherVariants.has(keyOf(value)),
      ) ||
      new Set(variants.map(keyOf)).size !== variants.length
    ) {
      toast.error(t("settings.dictionaries.invalidEntry"));
      return;
    }
    const entry: DictionaryEntry = { term, variants };
    const entries = [...selected.entries];
    if (editingIndex === -1) entries.push(entry);
    else entries[editingIndex] = entry;
    if (await replaceSelected({ ...selected, entries })) setEditingIndex(null);
  };

  const removeEntry = async (index: number) => {
    if (!selected) return;
    await replaceSelected({
      ...selected,
      entries: selected.entries.filter((_, i) => i !== index),
    });
  };

  const importTerms = async () => {
    if (!selected || preview.terms.length === 0) return;
    const entries = [
      ...selected.entries,
      ...preview.terms.map((term) => ({ term, variants: [] })),
    ];
    if (await replaceSelected({ ...selected, entries })) setBulkText("");
  };

  const visibleEntries =
    selected?.entries
      .map((entry, index) => ({ entry, index }))
      .filter(
        ({ entry }) =>
          keyOf(entry.term).includes(keyOf(search)) ||
          entry.variants.some((variant) =>
            keyOf(variant).includes(keyOf(search)),
          ),
      ) ?? [];
  const selectedIndex = dictionaries.findIndex(
    (item) => item.id === selected?.id,
  );

  if (isLoading) {
    return (
      <p className="text-sm text-ink-3 p-4">
        {t("settings.dictionaries.loading")}
      </p>
    );
  }

  return (
    <div className="max-w-4xl w-full mx-auto space-y-6 p-2">
      <div>
        <h1 className="text-xl font-semibold">
          {t("settings.dictionaries.title")}
        </h1>
        <p className="text-sm text-ink-3 mt-1">
          {t("settings.dictionaries.description")}
        </p>
      </div>

      <div className="flex gap-2">
        <Input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void createDictionary();
          }}
          placeholder={t("settings.dictionaries.newName")}
          aria-label={t("settings.dictionaries.newName")}
          disabled={saving}
          className="flex-1"
        />
        <Button
          onClick={createDictionary}
          disabled={saving || !normalize(newName)}
        >
          {t("settings.dictionaries.create")}
        </Button>
      </div>

      <div className="grid gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
        <div className="space-y-2">
          {dictionaries.map((dictionary) => (
            <div
              key={dictionary.id}
              className={`flex items-center gap-2 rounded-lg border p-2 ${selected?.id === dictionary.id ? "border-logo-primary bg-logo-primary/10" : "border-line"}`}
            >
              <button
                className="flex-1 text-start min-w-0"
                onClick={() => setSelectedId(dictionary.id)}
              >
                <span className="block text-sm font-medium truncate">
                  {displayName(dictionary)}
                </span>
                <span className="text-xs text-ink-3">
                  {t("settings.dictionaries.termCount", {
                    count: dictionary.entries.length,
                  })}
                </span>
              </button>
              <Switch
                checked={dictionary.enabled}
                disabled={saving}
                ariaLabel={t("settings.dictionaries.toggle", {
                  name: displayName(dictionary),
                })}
                onChange={(enabled) =>
                  void save(
                    dictionaries.map((item) =>
                      item.id === dictionary.id ? { ...item, enabled } : item,
                    ),
                  )
                }
              />
            </div>
          ))}
          {dictionaries.length === 0 && (
            <p className="text-sm text-ink-3">
              {t("settings.dictionaries.empty")}
            </p>
          )}
        </div>

        {selected && (
          <div className="space-y-5 min-w-0">
            <div className="rounded-lg border border-line p-4 space-y-3">
              <div className="flex gap-2">
                <Input
                  value={nameDraft}
                  onChange={(event) => setNameDraft(event.target.value)}
                  aria-label={t("settings.dictionaries.name")}
                  disabled={saving}
                  className="flex-1 min-w-0"
                />
                <Button
                  variant="secondary"
                  onClick={renameDictionary}
                  disabled={
                    saving || normalize(nameDraft) === displayName(selected)
                  }
                >
                  {t("settings.dictionaries.rename")}
                </Button>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => moveDictionary(-1)}
                  disabled={saving || selectedIndex <= 0}
                  aria-label={t("settings.dictionaries.moveUp")}
                  title={t("settings.dictionaries.moveUp")}
                >
                  <ArrowUp className="w-4 h-4" />
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => moveDictionary(1)}
                  disabled={saving || selectedIndex >= dictionaries.length - 1}
                  aria-label={t("settings.dictionaries.moveDown")}
                  title={t("settings.dictionaries.moveDown")}
                >
                  <ArrowDown className="w-4 h-4" />
                </Button>
                <Button
                  variant="danger-ghost"
                  onClick={deleteDictionary}
                  disabled={saving}
                >
                  {t("settings.dictionaries.delete")}
                </Button>
              </div>
              <p className="text-xs text-ink-3">
                {t("settings.dictionaries.variantsHelp")}
              </p>
            </div>

            {conflicts.length > 0 && (
              <div className="rounded-lg bg-warning-wash p-3 text-sm">
                <p className="font-medium">
                  {t("settings.dictionaries.conflicts")}
                </p>
                <p className="text-xs text-ink-3">
                  {t("settings.dictionaries.conflictsHelp")}
                </p>
                <ul className="list-disc ms-5 mt-1">
                  {conflicts.map((conflict) => (
                    <li key={conflict}>{conflict}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="rounded-lg border border-line p-4 space-y-3">
              <div className="flex gap-2">
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("settings.dictionaries.search")}
                  aria-label={t("settings.dictionaries.search")}
                  className="flex-1 min-w-0"
                />
                <Button onClick={() => beginEntry(-1)} disabled={saving}>
                  {t("settings.dictionaries.addTerm")}
                </Button>
              </div>
              {editingIndex !== null && (
                <div className="rounded-lg bg-wash p-3 space-y-2">
                  <Input
                    value={termDraft}
                    onChange={(event) => setTermDraft(event.target.value)}
                    placeholder={t("settings.dictionaries.term")}
                    aria-label={t("settings.dictionaries.term")}
                    disabled={saving}
                    className="w-full"
                  />
                  <Textarea
                    value={variantsDraft}
                    onChange={(event) => setVariantsDraft(event.target.value)}
                    placeholder={t("settings.dictionaries.variants")}
                    aria-label={t("settings.dictionaries.variants")}
                    disabled={saving}
                    className="w-full"
                  />
                  <div className="flex gap-2">
                    <Button onClick={saveEntry} disabled={saving}>
                      {t("settings.dictionaries.save")}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => setEditingIndex(null)}
                      disabled={saving}
                    >
                      {t("settings.dictionaries.cancel")}
                    </Button>
                  </div>
                </div>
              )}
              <div className="max-h-72 overflow-y-auto divide-y divide-line">
                {visibleEntries.map(({ entry, index }) => (
                  <div
                    key={`${index}-${entry.term}`}
                    className="flex items-center gap-2 py-2"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium break-words">
                        {entry.term}
                      </p>
                      {entry.variants.length > 0 && (
                        <p className="text-xs text-ink-3 break-words">
                          {entry.variants.join(", ")}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => beginEntry(index)}
                      disabled={saving}
                    >
                      {t("settings.dictionaries.edit")}
                    </Button>
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      onClick={() => removeEntry(index)}
                      disabled={saving}
                    >
                      {t("settings.dictionaries.remove")}
                    </Button>
                  </div>
                ))}
                {visibleEntries.length === 0 && (
                  <p className="text-sm text-ink-3 py-3">
                    {t("settings.dictionaries.noTerms")}
                  </p>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-line p-4 space-y-3">
              <h2 className="font-medium">
                {t("settings.dictionaries.importTitle")}
              </h2>
              <p className="text-xs text-ink-3">
                {t("settings.dictionaries.importHelp")}
              </p>
              <Textarea
                value={bulkText}
                onChange={(event) => setBulkText(event.target.value)}
                placeholder={t("settings.dictionaries.importPlaceholder")}
                aria-label={t("settings.dictionaries.importTitle")}
                disabled={saving}
                className="w-full min-h-32"
              />
              {bulkText.trim() && (
                <div className="text-sm space-y-1">
                  <p>
                    {t("settings.dictionaries.preview", {
                      add: preview.terms.length,
                      duplicates: preview.duplicates.length,
                      invalid: preview.invalid.length,
                    })}
                  </p>
                  {preview.terms.length > 0 && (
                    <p className="break-words">{preview.terms.join(" · ")}</p>
                  )}
                  {preview.duplicates.length > 0 && (
                    <p className="text-ink-3 break-words">
                      {t("settings.dictionaries.duplicateList", {
                        terms: preview.duplicates.join(", "),
                      })}
                    </p>
                  )}
                  {preview.invalid.length > 0 && (
                    <p className="text-error break-words">
                      {t("settings.dictionaries.invalidList", {
                        terms: preview.invalid.join(", "),
                      })}
                    </p>
                  )}
                </div>
              )}
              <Button
                onClick={importTerms}
                disabled={saving || preview.terms.length === 0}
              >
                {t("settings.dictionaries.import", {
                  count: preview.terms.length,
                })}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
