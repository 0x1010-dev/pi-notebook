/** Read-only bridge to @juicesharp/rpiv-todo's persisted state. Returns [] when absent. */

interface TodoTask {
  id: number;
  subject: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
}

export interface TodoSnapshot {
  open: TodoTask[];
  completed: number;
}

function isTaskDetails(value: unknown): value is { tasks: TodoTask[] } {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as { tasks?: unknown }).tasks)
  );
}

export function readTodos(branch: Iterable<unknown>): TodoSnapshot {
  let fromEntries: TodoTask[] | undefined;
  let fromResults: TodoTask[] | undefined;
  for (const raw of branch) {
    const e = raw as {
      type?: string;
      customType?: string;
      data?: unknown;
      message?: { role?: string; toolName?: string; details?: unknown };
    };
    if (
      e.type === "custom" &&
      e.customType === "rpiv-todo-state" &&
      isTaskDetails(e.data)
    ) {
      fromEntries = e.data.tasks;
    } else if (
      e.type === "message" &&
      e.message?.role === "toolResult" &&
      e.message.toolName === "todo" &&
      isTaskDetails(e.message.details)
    ) {
      fromResults = e.message.details.tasks;
    }
  }
  const tasks = (fromEntries ?? fromResults ?? []).filter(
    (t) => t && typeof t.subject === "string",
  );
  return {
    open: tasks.filter(
      (t) => t.status === "pending" || t.status === "in_progress",
    ),
    completed: tasks.filter((t) => t.status === "completed").length,
  };
}

export function formatTodos(snapshot: TodoSnapshot): string[] {
  return snapshot.open.map(
    (t) => `[${t.status === "in_progress" ? "~" : " "}] ${t.subject}`,
  );
}
