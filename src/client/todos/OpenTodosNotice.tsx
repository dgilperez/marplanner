import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import type { OpenTodos } from "./useOpenTodos";

interface OpenTodosNoticeProps extends Pick<OpenTodos, "readFailed" | "writeError" | "reload"> {
  /** The element the host's layout needs around the notice. */
  as: "li" | "div";
  className: string;
  /** Copy for a failed read; a failed completion brings its own. */
  readErrorKey: MessageKey;
}

/** What went wrong with a listing of open to-dos: a failed read, with a retry, or else a failed
 * completion. Renders nothing while neither failed. */
export function OpenTodosNotice({
  as: Wrapper,
  className,
  readErrorKey,
  readFailed,
  writeError,
  reload,
}: OpenTodosNoticeProps) {
  const { t } = useTranslation();
  if (!readFailed && writeError === null) return null;
  return (
    <Wrapper className={className}>
      <ErrorNotice message={readFailed ? t(readErrorKey) : writeError && t(writeError)} />
      {readFailed && (
        <Button type="button" variant="outline" onClick={reload}>
          {t("todos.agenda.retry")}
        </Button>
      )}
    </Wrapper>
  );
}
