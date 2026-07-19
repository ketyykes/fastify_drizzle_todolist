import { Trash2Icon } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { getErrorMessage } from "@/lib/errors";
import { createTodo, deleteTodo, fetchTodos, updateTodo, type Todo } from "@/lib/todos-api";

export default function Todos() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let active = true;
    fetchTodos()
      .then((data) => {
        if (active) setTodos(data);
      })
      .catch((err) => toast.error(getErrorMessage(err)))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    setAdding(true);
    try {
      const created = await createTodo(title);
      setTodos((prev) => [...prev, created]);
      setNewTitle("");
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setAdding(false);
    }
  }

  async function handleToggle(todo: Todo) {
    try {
      const updated = await updateTodo(todo.id, { completed: !todo.completed });
      setTodos((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  async function handleDelete(id: number) {
    try {
      await deleteTodo(id);
      setTodos((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  return (
    <main className="container mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-4 text-lg font-semibold">My Todos</h1>

      <form onSubmit={handleAdd} className="mb-6 flex gap-2">
        <Input
          placeholder="Add a new task..."
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
        />
        <Button type="submit" disabled={adding || newTitle.trim().length === 0}>
          Add
        </Button>
      </form>

      {loading ? (
        <p className="text-muted-foreground text-sm">載入中...</p>
      ) : todos.length === 0 ? (
        <p className="text-muted-foreground text-sm">No tasks yet. Add one above.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {todos.map((todo) => (
            <li key={todo.id} className="flex items-center gap-3 border p-3">
              <Checkbox checked={todo.completed} onCheckedChange={() => handleToggle(todo)} />
              <span
                className={todo.completed ? "text-muted-foreground flex-1 line-through" : "flex-1"}
              >
                {todo.title}
              </span>
              <Button
                variant="destructive"
                size="icon-sm"
                onClick={() => handleDelete(todo.id)}
                aria-label="Delete"
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
