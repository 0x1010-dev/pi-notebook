import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMIT_RE, detectNudge, freshRun, looksLikePreference } from "./signals.ts";
import { readTodos } from "./todos.ts";

test("preference detection", () => {
	assert.ok(looksLikePreference("From now on use pnpm"));
	assert.ok(looksLikePreference("I prefer tabs"));
	assert.ok(looksLikePreference("never use em-dashes"));
	assert.ok(!looksLikePreference("fix the failing test"));
	assert.ok(!looksLikePreference("don't break the build"));
});

test("commit detection", () => {
	assert.ok(COMMIT_RE.test('git commit -m "x"'));
	assert.ok(COMMIT_RE.test("git -C repo commit -am wip"));
	assert.ok(!COMMIT_RE.test("git status && echo commit"));
});

test("nudge priority", () => {
	const f = freshRun();
	assert.equal(detectNudge(f, 0, 10), undefined);
	assert.equal(detectNudge({ ...f, recovered: true }, 0, 10), "lesson");
	assert.equal(detectNudge({ ...f, recovered: true, committed: true }, 0, 10), "milestone");
	assert.equal(detectNudge(f, 10, 10), "checkpoint");
	assert.equal(detectNudge({ ...f, committed: true, saved: true }, 10, 10), undefined);
});

test("todo bridge prefers state entries", () => {
	const branch = [
		{ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: [{ id: 1, subject: "old", status: "pending" }], nextId: 2 } } },
		{
			type: "custom",
			customType: "rpiv-todo-state",
			data: {
				tasks: [
					{ id: 1, subject: "a", status: "completed" },
					{ id: 2, subject: "b", status: "in_progress" },
					{ id: 3, subject: "c", status: "deleted" },
				],
				nextId: 4,
			},
		},
	];
	const snap = readTodos(branch);
	assert.equal(snap.completed, 1);
	assert.deepEqual(snap.open.map((t) => t.subject), ["b"]);
	assert.deepEqual(readTodos([]).open, []);
});
