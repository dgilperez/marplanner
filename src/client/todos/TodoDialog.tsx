import { useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Field } from "@/components/Field";
import { MemberPills } from "@/components/MemberPills";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "@/i18n";
import { NATIVE_SELECT_CLASSES } from "@/lib/recipes";
import {
  TODO_NOTES_MAX_LENGTH,
  TODO_REPEAT_EVERY_MAX,
  TODO_REPEAT_EVERY_MIN,
  TODO_REPEAT_UNITS,
  TODO_TITLE_MAX_LENGTH,
  hasVisibleCharacter,
  isTodoRepeat,
  sameTodoRepeat,
  type Member,
  type Todo,
  type TodoCreate,
  type TodoList,
  type TodoPatch,
  type TodoRepeatUnit,
} from "../../shared";
import { assignableAdults, repeatLabel } from "./todo-presentation";
import type { WriteResult } from "./useTodosWorkspace";

interface TodoDialogProps {
  /** The to-do being edited; null creates one. */
  todo: Todo | null;
  /** Title and list a new to-do starts with. */
  initialTitle: string;
  initialListId: string;
  lists: readonly TodoList[];
  members: readonly Member[];
  onClose(): void;
  onCreate(input: TodoCreate): Promise<WriteResult>;
  onEdit(todoId: string, patch: TodoPatch): Promise<WriteResult>;
  onDelete(todoId: string): Promise<WriteResult>;
}

/** The full form of a to-do, for adding with details and for editing. Mount it only while it is
 * open: it starts from its props. */
export function TodoDialog({
  todo,
  initialTitle,
  initialListId,
  lists,
  members,
  onClose,
  onCreate,
  onEdit,
  onDelete,
}: TodoDialogProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(todo?.title ?? initialTitle);
  const [notes, setNotes] = useState(todo?.notes ?? "");
  const [dueDate, setDueDate] = useState(todo?.dueDate ?? "");
  const [assigneeId, setAssigneeId] = useState(todo?.assigneeMemberId ?? null);
  const [listId, setListId] = useState(todo?.listId ?? initialListId);
  /** The unit of the repeat rule; empty for a to-do that does not repeat. */
  const [repeatUnit, setRepeatUnit] = useState<TodoRepeatUnit | "">(todo?.repeat?.unit ?? "");
  const [repeatEvery, setRepeatEvery] = useState(String(todo?.repeat?.every ?? 1));
  const [repeatError, setRepeatError] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // The stored assignee stays in the picker when it is no longer an active adult, so an edit of
  // something else shows who has the to-do and does not have to replace them (TODOS-INV-05).
  const adults = assignableAdults(members);
  const storedAssignee = members.find(
    (member) =>
      member.id === todo?.assigneeMemberId && !adults.some((adult) => adult.id === member.id)
  );
  const assignees = storedAssignee ? [...adults, storedAssignee] : adults;

  // A rule counts from the due date, so without one the to-do does not repeat (TODOS-INV-11).
  const repeats = dueDate !== "" && repeatUnit !== "";
  const typedRepeat = { every: Number(repeatEvery), unit: repeatUnit };
  const repeat = repeats && isTodoRepeat(typedRepeat) ? typedRepeat : null;

  async function finish(write: Promise<WriteResult>) {
    setSaving(true);
    setError(null);
    const failure = await write;
    setSaving(false);
    if (failure === null) onClose();
    else setError(t(failure));
  }

  function save() {
    const trimmedTitle = title.trim();
    if (!hasVisibleCharacter(trimmedTitle)) {
      setTitleError(t("todos.field.titleRequired"));
      return;
    }
    if (repeats && repeat === null) {
      setRepeatError(t("todos.field.repeatEveryInvalid"));
      return;
    }
    const fields: Required<Omit<TodoCreate, "repeat">> = {
      listId,
      title: trimmedTitle,
      notes: notes.trim() ? notes : null,
      dueDate: dueDate || null,
      assigneeMemberId: assigneeId,
    };
    // A new to-do has nothing stored: its required fields always count as changed, and an unset
    // optional field is left out because the API stores it as null.
    const stored: TodoPatch = todo ?? { notes: null, dueDate: null, assigneeMemberId: null };
    const changes: TodoPatch = Object.fromEntries(
      Object.entries(fields).filter(([field, value]) => value !== stored[field as keyof TodoCreate])
    );
    if (!sameTodoRepeat(repeat, todo?.repeat ?? null)) changes.repeat = repeat;
    if (todo === null) void finish(onCreate({ ...changes, listId, title: trimmedTitle }));
    else if (Object.keys(changes).length === 0) onClose();
    else void finish(onEdit(todo.id, changes));
  }

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !saving) onClose();
        }}
      >
        <DialogContent
          closeLabel={t("todos.action.close")}
          aria-describedby={undefined}
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>
              {todo ? t("todos.dialog.editTitle") : t("todos.dialog.createTitle")}
            </DialogTitle>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            // The form reports its own errors in the UI language; the browser's bubble for the
            // interval's range would replace them.
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <Field label={t("todos.field.title")} error={titleError}>
              <Input
                value={title}
                maxLength={TODO_TITLE_MAX_LENGTH}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setTitleError(null);
                }}
              />
            </Field>
            <Field label={t("todos.field.notes")}>
              <Textarea
                value={notes}
                maxLength={TODO_NOTES_MAX_LENGTH}
                onChange={(event) => setNotes(event.target.value)}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("todos.field.dueDate")}>
                <Input
                  type="date"
                  value={dueDate}
                  onChange={(event) => setDueDate(event.target.value)}
                />
              </Field>
              <Field label={t("todos.field.list")}>
                <select
                  value={listId}
                  onChange={(event) => setListId(event.target.value)}
                  className={NATIVE_SELECT_CLASSES}
                >
                  {lists.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t("todos.field.repeat")}
                hint={dueDate === "" ? t("todos.field.repeatHint") : undefined}
              >
                <select
                  value={repeats ? repeatUnit : ""}
                  disabled={dueDate === ""}
                  onChange={(event) => {
                    setRepeatUnit(event.target.value as TodoRepeatUnit | "");
                    setRepeatError(null);
                  }}
                  className={NATIVE_SELECT_CLASSES}
                >
                  <option value="">{t("todos.repeat.never")}</option>
                  {TODO_REPEAT_UNITS.map((unit) => (
                    <option key={unit} value={unit}>
                      {t(`todos.repeat.unit.${unit}`)}
                    </option>
                  ))}
                </select>
              </Field>
              {repeats && (
                <Field label={t("todos.field.repeatEvery")} error={repeatError}>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={TODO_REPEAT_EVERY_MIN}
                    max={TODO_REPEAT_EVERY_MAX}
                    step={1}
                    value={repeatEvery}
                    onChange={(event) => {
                      setRepeatEvery(event.target.value);
                      setRepeatError(null);
                    }}
                  />
                </Field>
              )}
            </div>
            {repeat && (
              <p className="text-muted-foreground text-control">{repeatLabel(repeat, t)}</p>
            )}
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-control mb-1.5 font-medium">
                {t("todos.field.assignee")}
              </legend>
              <p className="text-muted-foreground text-control">{t("todos.field.assigneeHint")}</p>
              <MemberPills
                members={assignees}
                value={assigneeId === null ? [] : [assigneeId]}
                // At most one assignee: picking another adult replaces the current one, and
                // tapping the current one again leaves the to-do with nobody.
                onChange={(next) => setAssigneeId(next.find((id) => id !== assigneeId) ?? null)}
                groupLabel={t("todos.field.assignee")}
                testIdPrefix="todo-assignee-option"
              />
            </fieldset>
            <ErrorNotice message={error} />
            <DialogFooter>
              {todo && (
                <Button
                  type="button"
                  variant="destructive"
                  disabled={saving}
                  onClick={() => setConfirmDelete(true)}
                >
                  {t("todos.action.delete")}
                </Button>
              )}
              <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
                {t("todos.action.cancel")}
              </Button>
              <Button type="submit" disabled={saving}>
                {todo ? t("todos.action.save") : t("todos.quickAdd.submit")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {todo && (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={t("todos.item.deleteConfirm")}
          description={todo.title}
          confirmLabel={t("todos.action.delete")}
          cancelLabel={t("todos.action.cancel")}
          onConfirm={() => void finish(onDelete(todo.id))}
        />
      )}
    </>
  );
}
