import { describe, expect, it } from "vitest";

import { messages } from "@/i18n/messages";
import { memberProfiles } from "@/home/agenda-presentation";
import { ApiError } from "@/lib/api";
import {
  assignableAdults,
  dueTodayThenOverdue,
  fillMessage,
  formatDueDate,
  isOverdue,
  listsInReadingOrder,
  repeatLabel,
  todoAssignees,
} from "@/todos/todo-presentation";
import { todosErrorKey } from "@/todos/todos-api";
import type { Todo, TodoList } from "../../src/shared";
import { PLUGIN_UNAVAILABLE_RESPONSE } from "../../src/shared";
import { householdMembers } from "./helpers/todosBackend";

const todo = (id: string, dueDate: string | null, completedAt: number | null = null): Todo => ({
  id,
  listId: "home",
  title: id,
  notes: null,
  dueDate,
  assigneeMemberId: null,
  repeat: null,
  completedAt,
  createdAt: 0,
  updatedAt: 0,
});

describe("to-do presentation", () => {
  it("treats only an open to-do due before today as overdue", () => {
    expect(isOverdue(todo("a", "2026-09-21"), "2026-09-22")).toBe(true);
    expect(isOverdue(todo("a", "2026-09-22"), "2026-09-22")).toBe(false);
    expect(isOverdue(todo("a", "2026-09-23"), "2026-09-22")).toBe(false);
    expect(isOverdue(todo("a", null), "2026-09-22")).toBe(false);
    expect(isOverdue(todo("a", "2026-09-21", 5), "2026-09-22")).toBe(false);
  });

  it("formats a due date in the UI language and adds the year only when it differs", () => {
    expect(formatDueDate("2026-09-18", "2026-09-22", "en")).toBe("Fri, Sep 18");
    expect(formatDueDate("2026-09-18", "2026-09-22", "es")).toBe("vie, 18 sept");
    expect(formatDueDate("2027-01-02", "2026-09-22", "en")).toBe("Sat, Jan 2, 2027");
    // A calendar date never shifts with the viewer's time zone.
    expect(formatDueDate("2026-01-01", "2026-09-22", "en")).toBe("Thu, Jan 1");
  });

  it("offers active parents only, in the order the household lists them", () => {
    expect(assignableAdults(householdMembers).map((member) => member.id)).toEqual([
      "blair",
      "dana",
    ]);
  });

  it("puts to-dos due today before overdue ones and keeps the read order inside each", () => {
    const read = [
      todo("oldest", "2026-09-01"),
      todo("yesterday", "2026-09-21"),
      todo("today-1", "2026-09-22"),
      todo("today-2", "2026-09-22"),
    ];
    expect(dueTodayThenOverdue(read, "2026-09-22").map((item) => item.id)).toEqual([
      "today-1",
      "today-2",
      "oldest",
      "yesterday",
    ]);
  });
});

describe("to-do assignee", () => {
  const profiles = memberProfiles(householdMembers);
  const assigned = (assigneeMemberId: string | null) => ({ assigneeMemberId });

  it("resolves an active assignee with its identity colour", () => {
    expect(todoAssignees(assigned("blair"), profiles)).toEqual({
      activeAssignees: [{ memberId: "blair", label: "Blair", colorKey: "pink" }],
      fallbackAssigneeLabels: [],
    });
  });

  it("keeps only a label for an archived or missing assignee, and nothing for nobody", () => {
    expect(todoAssignees(assigned("eli"), profiles)).toEqual({
      activeAssignees: [],
      fallbackAssigneeLabels: ["Eli"],
    });
    expect(todoAssignees(assigned("gone"), profiles).fallbackAssigneeLabels).toEqual(["gone"]);
    expect(todoAssignees(assigned(null), profiles)).toEqual({
      activeAssignees: [],
      fallbackAssigneeLabels: [],
    });
  });
});

describe("to-do copy and order", () => {
  it("fills placeholders with the values as they are, in one pass", () => {
    expect(fillMessage("{name} ({count})", { name: "Budget $$", count: 3 })).toBe("Budget $$ (3)");
    expect(fillMessage("“{name}”", { name: "$& $1 $` $'" })).toBe("“$& $1 $` $'”");
    expect(fillMessage("{name} ({count})", { name: "{count} {name}", count: 0 })).toBe(
      "{count} {name} (0)"
    );
    expect(fillMessage("{name} {name}", { name: "x" })).toBe("x x");
  });

  it("leaves a placeholder nobody filled as written", () => {
    expect(fillMessage("{name} ({count})", { name: "Home" })).toBe("Home ({count})");
  });

  it("orders lists by name in the UI language without moving the read", () => {
    const list = (name: string): TodoList => ({
      id: name,
      name,
      openCount: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    const read = ["alfa", "Beta", "Home", "nube", "Two", "zeta", "Árbol", "Ñu"].map(list);
    const names = (language: "en" | "es") =>
      listsInReadingOrder(read, language).map((item) => item.name);
    expect(names("es")).toEqual(["alfa", "Árbol", "Beta", "Home", "nube", "Ñu", "Two", "zeta"]);
    expect(names("en")).toEqual(["alfa", "Árbol", "Beta", "Home", "Ñu", "nube", "Two", "zeta"]);
    expect(read.map((item) => item.name).at(-1)).toBe("Ñu");
  });
});

describe("to-do repeat label", () => {
  it.each([
    ["en", 1, "day", "Repeats every day"],
    ["en", 3, "day", "Repeats every 3 days"],
    ["en", 1, "week", "Repeats every week"],
    ["en", 2, "week", "Repeats every 2 weeks"],
    ["en", 1, "month", "Repeats every month"],
    ["en", 6, "month", "Repeats every 6 months"],
    ["en", 1, "year", "Repeats every year"],
    ["en", 99, "year", "Repeats every 99 years"],
    ["es", 1, "day", "Se repite cada día"],
    ["es", 3, "day", "Se repite cada 3 días"],
    ["es", 1, "week", "Se repite cada semana"],
    ["es", 2, "week", "Se repite cada 2 semanas"],
    ["es", 1, "month", "Se repite cada mes"],
    ["es", 6, "month", "Se repite cada 6 meses"],
    ["es", 1, "year", "Se repite cada año"],
    ["es", 99, "year", "Se repite cada 99 años"],
  ] as const)("%s: every %i %s reads %s", (language, every, unit, expected) => {
    const t = (key: keyof (typeof messages)["en"]) => messages[language][key];
    expect(repeatLabel({ every, unit }, t)).toBe(expected);
  });
});

describe("to-dos request failures", () => {
  it("chooses the copy by the API's stable code", () => {
    const failure = (code: string | null) => new ApiError(503, code, "/api/todos");
    expect(todosErrorKey(failure(PLUGIN_UNAVAILABLE_RESPONSE.code), "todos.error")).toBe(
      "todos.unavailable"
    );
    expect(todosErrorKey(failure("duplicate_name"), "todos.error")).toBe(
      "todos.lists.duplicateName"
    );
    expect(todosErrorKey(failure("internal_error"), "todos.error")).toBe("todos.error");
    expect(todosErrorKey(failure(null), "todos.actionError")).toBe("todos.actionError");
    expect(todosErrorKey(new TypeError("Failed to fetch"), "todos.error")).toBe("todos.error");
  });
});

describe("todos-i18n-parity", () => {
  const isTodosKey = (key: string) =>
    key.startsWith("todos.") || key.startsWith("plugins.todos.") || key === "shell.nav.todos";

  it("has every to-dos key in English and Spanish with non-empty copy", () => {
    const en = Object.keys(messages.en).filter(isTodosKey).sort();
    const es = Object.keys(messages.es).filter(isTodosKey).sort();
    expect(en.length).toBeGreaterThan(20);
    expect(es).toEqual(en);
    for (const key of en) {
      expect(messages.en[key as keyof typeof messages.en].trim()).not.toBe("");
      expect(messages.es[key as keyof typeof messages.es].trim()).not.toBe("");
    }
  });

  it("never calls to-dos tasks, which the kiosk reserves for the children's chores", () => {
    for (const locale of ["en", "es"] as const) {
      for (const key of Object.keys(messages[locale]).filter(isTodosKey)) {
        expect(messages[locale][key as keyof typeof messages.en]).not.toMatch(
          /\b(tasks?|tareas?)\b/i
        );
      }
    }
  });

  it("keeps the placeholders of each key identical across languages", () => {
    const placeholders = (text: string) => (text.match(/\{[a-z]+\}/g) ?? []).sort();
    for (const key of Object.keys(messages.en).filter(isTodosKey)) {
      expect(placeholders(messages.es[key as keyof typeof messages.es])).toEqual(
        placeholders(messages.en[key as keyof typeof messages.en])
      );
    }
  });
});
