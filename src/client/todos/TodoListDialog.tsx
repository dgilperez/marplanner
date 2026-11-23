import { useState } from "react";

import { Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/i18n";
import { TODO_LIST_NAME_MAX_LENGTH, hasVisibleCharacter } from "../../shared";
import type { WriteResult } from "./useTodosWorkspace";

interface TodoListDialogProps {
  mode: "create" | "rename";
  initialName: string;
  onClose(): void;
  onSave(name: string): Promise<WriteResult>;
}

/** Names a new list or renames one. Mount it only while it is open: it starts from its props. */
export function TodoListDialog({ mode, initialName, onClose, onSave }: TodoListDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    const trimmed = name.trim();
    if (!hasVisibleCharacter(trimmed)) {
      setError(t("todos.lists.nameRequired"));
      return;
    }
    setSaving(true);
    const failure = await onSave(trimmed);
    setSaving(false);
    if (failure === null) onClose();
    else setError(t(failure));
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <DialogContent closeLabel={t("todos.action.close")} aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? t("todos.lists.new") : t("todos.lists.rename")}
          </DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field label={t("todos.lists.nameLabel")} error={error}>
            <Input
              value={name}
              maxLength={TODO_LIST_NAME_MAX_LENGTH}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              {t("todos.action.cancel")}
            </Button>
            <Button type="submit" disabled={saving}>
              {t("todos.action.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
