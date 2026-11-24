import { ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { AdminPinPad } from "@/admin/AdminPinPad";
import { CheckboxField } from "@/components/CheckboxField";
import { ChoicePills } from "@/components/ChoicePills";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorNotice } from "@/components/ErrorNotice";
import { MEMBER_DOT_CLASS } from "@/components/MemberPills";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { memberProfiles } from "@/home/agenda-presentation";
import { useTranslation } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { isAdminPinBypassEnabled, useAdminUnlock } from "@/lib/adminUnlock";
import { useHouseholdToday } from "@/lib/household-date";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { cn } from "@/lib/utils";
import {
  TODO_TITLE_MAX_LENGTH,
  hasVisibleCharacter,
  type Member,
  type Todo,
  type TodoCreate,
  type TodoList,
} from "../../shared";
import { TodoDialog } from "./TodoDialog";
import { TodoDue } from "./TodoDue";
import { TodoListDialog } from "./TodoListDialog";
import { TodoRepeatMark } from "./TodoRepeatMark";
import { fillMessage, todoAssignees } from "./todo-presentation";
import { useTodosWorkspace, type WriteResult } from "./useTodosWorkspace";

interface TodoRowProps {
  todo: Todo;
  today: string | null;
  profiles: ReadonlyMap<string, Member>;
  pending: boolean;
  onToggle(todo: Todo, completed: boolean): void;
  onEdit(todo: Todo): void;
}

function TodoRow({ todo, today, profiles, pending, onToggle, onEdit }: TodoRowProps) {
  const { t } = useTranslation();
  const done = todo.completedAt !== null;
  const { activeAssignees, fallbackAssigneeLabels } = todoAssignees(todo, profiles);
  const assignee = activeAssignees.at(0);
  const assigneeLabel = assignee?.label ?? fallbackAssigneeLabels.at(0);
  return (
    <li className="bg-card flex items-start gap-2 rounded-2xl border px-3 py-1">
      <div className="min-w-0 flex-1">
        <CheckboxField
          checked={done}
          disabled={pending}
          onChange={(completed) => onToggle(todo, completed)}
          label={todo.title}
          className={cn(
            "w-full font-semibold wrap-anywhere",
            done && "text-muted-foreground line-through"
          )}
        />
        {(todo.dueDate !== null || assigneeLabel !== undefined) && (
          <p className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 pb-2 pl-[calc(var(--control-height)+0.5rem)] text-sm">
            <TodoDue todo={todo} today={today} />
            {todo.repeat && <TodoRepeatMark repeat={todo.repeat} />}
            {assigneeLabel !== undefined && (
              <span data-testid="todo-assignee" className="inline-flex items-center gap-1.5">
                {assignee && (
                  <span
                    aria-hidden="true"
                    className={cn("size-3 rounded-full", MEMBER_DOT_CLASS[assignee.colorKey])}
                  />
                )}
                {assigneeLabel}
              </span>
            )}
          </p>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="text-muted-foreground"
        title={t("todos.item.edit")}
        aria-label={`${t("todos.item.edit")}: ${todo.title}`}
        onClick={() => onEdit(todo)}
      >
        <ChevronRight aria-hidden="true" />
      </Button>
    </li>
  );
}

function LoadingStatus() {
  const { t } = useTranslation();
  return (
    <p role="status" className="text-muted-foreground">
      {t("todos.loading")}
    </p>
  );
}

function RetryNotice({ message, onRetry }: { message: MessageKey; onRetry(): void }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <ErrorNotice message={t(message)} />
      <Button type="button" variant="outline" onClick={onRetry}>
        {t("todos.retry")}
      </Button>
    </div>
  );
}

/** The kiosk page of the to-dos plugin: lists across the top, the selected list's open to-dos,
 * and its done ones on demand. Writes need no admin PIN, like the Calendar page's own events,
 * except deleting a list, which takes its to-dos with it. The PIN is a gate of this page only:
 * the API accepts the deletion from any provisioned device. */
export function TodosBoard(): React.JSX.Element {
  const { t } = useTranslation();
  const { timezone } = useHouseholdSettings();
  const workspace = useTodosWorkspace();
  const { lists, selectedList, open, done } = workspace;
  const { unlocked } = useAdminUnlock();
  const [quickTitle, setQuickTitle] = useState("");
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<MessageKey | null>(null);
  const [listDialog, setListDialog] = useState<"create" | "rename" | null>(null);
  /** The to-do in the dialog; `null` inside the wrapper means a new one. */
  const [todoDialog, setTodoDialog] = useState<{ todo: Todo | null } | null>(null);
  /** `count` is undefined while it is read and null when the read failed. */
  const [deleting, setDeleting] = useState<{ list: TodoList; count?: number | null } | null>(null);
  /** The list whose deletion waits for the admin PIN. */
  const [pinFor, setPinFor] = useState<TodoList | null>(null);
  const listHeadingId = useId();
  const doneRegionId = useId();
  const today = useHouseholdToday(timezone);
  const profiles = useMemo(() => memberProfiles(workspace.members), [workspace.members]);

  /** Runs a write made outside a dialog and reports its failure on the page. */
  async function report(write: Promise<WriteResult>): Promise<void> {
    setActionError(null);
    setActionError(await write);
  }

  /** Creates a to-do, from the quick-add row or the dialog, and empties the quick-add title the
   * dialog may have started from. */
  async function createTodo(input: TodoCreate): Promise<WriteResult> {
    const failure = await workspace.createTodo(input);
    if (failure === null) setQuickTitle("");
    return failure;
  }

  async function quickAdd(list: TodoList) {
    const title = quickTitle.trim();
    // A second Enter or tap while the first request is on its way would add the to-do twice.
    if (adding || !hasVisibleCharacter(title)) return;
    setAdding(true);
    await report(createTodo({ listId: list.id, title }));
    setAdding(false);
  }

  /** Deleting a list asks for the admin PIN first, unless the admin session is unlocked. The
   * PIN covers that one deletion and unlocks nothing else. */
  function requestDeletion(list: TodoList) {
    if (unlocked || isAdminPinBypassEnabled()) askToDelete(list);
    else setPinFor(list);
  }

  function askToDelete(list: TodoList) {
    setDeleting({ list });
    void workspace
      .countTodos(list.id)
      .then((count) =>
        setDeleting((current) => (current?.list.id === list.id ? { list, count } : current))
      );
  }

  function deletionWarning(count: number | null | undefined): string {
    if (count === undefined) return t("todos.lists.deleteCounting");
    if (count === null) return t("todos.lists.deleteUnknown");
    if (count === 0) return t("todos.lists.deleteEmpty");
    if (count === 1) return t("todos.lists.deleteOne");
    return fillMessage(t("todos.lists.deleteMany"), { count });
  }

  const renderRows = (todos: readonly Todo[], label: string) => (
    <ul aria-label={label} className="m-0 flex list-none flex-col gap-2 p-0">
      {todos.map((todo) => (
        <TodoRow
          key={todo.id}
          todo={todo}
          today={today}
          profiles={profiles}
          pending={workspace.pendingIds.has(todo.id)}
          onToggle={(item, completed) => void report(workspace.setCompleted(item, completed))}
          onEdit={(item) => setTodoDialog({ todo: item })}
        />
      ))}
    </ul>
  );

  /** A list of to-dos, or what stands in for it: nothing while a failed read shows its retry. */
  const renderItems = (todos: readonly Todo[] | null, emptyKey: MessageKey, label: string) => {
    if (todos === null) return workspace.itemsError ? null : <LoadingStatus />;
    if (todos.length === 0) return <p className="text-muted-foreground">{t(emptyKey)}</p>;
    return renderRows(todos, label);
  };

  return (
    <main data-testid="todos-board" className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold tracking-tight">{t("todos.title")}</h1>
      {workspace.loadError && (
        <RetryNotice message={workspace.loadError} onRetry={workspace.retryLoad} />
      )}
      {lists === null && !workspace.loadError && <LoadingStatus />}
      {lists?.length === 0 && (
        <div className="flex flex-col items-start gap-3">
          <p className="text-muted-foreground">{t("todos.lists.empty")}</p>
          <Button type="button" className="gap-2" onClick={() => setListDialog("create")}>
            <Plus aria-hidden="true" />
            {t("todos.lists.createFirst")}
          </Button>
        </div>
      )}
      {lists !== null && selectedList !== null && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <ChoicePills
              groupLabel={t("todos.lists.label")}
              value={selectedList.id}
              onChange={workspace.selectList}
              options={lists.map((list) => ({
                value: list.id,
                label: fillMessage(t("todos.lists.pill"), {
                  name: list.name,
                  count: list.openCount,
                }),
                "data-testid": `todos-list-${list.id}`,
              }))}
            />
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              onClick={() => setListDialog("create")}
            >
              <Plus aria-hidden="true" />
              {t("todos.lists.new")}
            </Button>
          </div>
          <section aria-labelledby={listHeadingId} className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id={listHeadingId} className="min-w-0 text-xl font-semibold wrap-anywhere">
                {selectedList.name}
              </h2>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="gap-2"
                  onClick={() => setListDialog("rename")}
                >
                  <Pencil aria-hidden="true" />
                  {t("todos.lists.rename")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="gap-2"
                  onClick={() => requestDeletion(selectedList)}
                >
                  <Trash2 aria-hidden="true" />
                  {t("todos.lists.delete")}
                </Button>
              </div>
            </div>
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void quickAdd(selectedList);
              }}
            >
              <Input
                className="min-w-0 flex-1 basis-64"
                aria-label={t("todos.quickAdd.label")}
                placeholder={t("todos.quickAdd.placeholder")}
                value={quickTitle}
                maxLength={TODO_TITLE_MAX_LENGTH}
                onChange={(event) => setQuickTitle(event.target.value)}
              />
              <Button type="submit" disabled={adding}>
                {t("todos.quickAdd.submit")}
              </Button>
              <Button type="button" variant="outline" onClick={() => setTodoDialog({ todo: null })}>
                {t("todos.quickAdd.details")}
              </Button>
            </form>
            <ErrorNotice message={actionError && t(actionError)} />
            {workspace.itemsError && (
              <RetryNotice message={workspace.itemsError} onRetry={workspace.retryItems} />
            )}
            {renderItems(open, "todos.items.empty", t("todos.items.openLabel"))}
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                variant="ghost"
                className="gap-2 self-start"
                aria-expanded={workspace.doneExpanded}
                aria-controls={workspace.doneExpanded ? doneRegionId : undefined}
                onClick={workspace.toggleDone}
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn("transition-transform", workspace.doneExpanded && "rotate-90")}
                />
                {t("todos.done.title")}
              </Button>
              {workspace.doneExpanded && (
                <div id={doneRegionId}>
                  {renderItems(done, "todos.done.empty", t("todos.done.listLabel"))}
                </div>
              )}
            </div>
          </section>
        </>
      )}
      {listDialog && (
        <TodoListDialog
          mode={listDialog}
          initialName={listDialog === "rename" ? (selectedList?.name ?? "") : ""}
          onClose={() => setListDialog(null)}
          onSave={(name) =>
            listDialog === "rename" && selectedList
              ? workspace.renameList(selectedList.id, name)
              : workspace.createList(name)
          }
        />
      )}
      {todoDialog && lists !== null && selectedList !== null && (
        <TodoDialog
          todo={todoDialog.todo}
          initialTitle={quickTitle.trim()}
          initialListId={selectedList.id}
          lists={lists}
          members={workspace.members}
          onClose={() => setTodoDialog(null)}
          onCreate={createTodo}
          onEdit={workspace.editTodo}
          onDelete={workspace.deleteTodo}
        />
      )}
      {pinFor && (
        <Dialog
          open
          // Always open while mounted, so the only change is a close.
          onOpenChange={() => setPinFor(null)}
        >
          <DialogContent
            showCloseButton={false}
            aria-describedby={undefined}
            className="justify-items-center bg-transparent p-0 shadow-none"
          >
            <DialogTitle className="sr-only">{t("todos.lists.deletePinTitle")}</DialogTitle>
            <AdminPinPad
              description={fillMessage(t("todos.lists.deletePin"), { name: pinFor.name })}
              onCancel={() => setPinFor(null)}
              onUnlock={() => {
                setPinFor(null);
                askToDelete(pinFor);
              }}
            />
          </DialogContent>
        </Dialog>
      )}
      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={() => setDeleting(null)}
          title={fillMessage(t("todos.lists.deleteConfirm"), { name: deleting.list.name })}
          description={deletionWarning(deleting.count)}
          confirmDisabled={deleting.count === undefined}
          confirmLabel={t("todos.action.delete")}
          cancelLabel={t("todos.action.cancel")}
          onConfirm={() => void report(workspace.deleteList(deleting.list.id))}
        />
      )}
    </main>
  );
}
