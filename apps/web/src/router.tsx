import { useAtomValue } from "jotai";
import type { ReactNode } from "react";
import { createBrowserRouter, Navigate } from "react-router";

import AppShell from "./app-shell";
import { tokenAtom } from "./lib/auth";
import Login from "./routes/login";
import OutboxGuide from "./routes/outbox-guide";
import Register from "./routes/register";
import Todos from "./routes/todos";

// 受保護路由：無 token 導回登入頁
function RequireAuth({ children }: { children: ReactNode }) {
  const token = useAtomValue(tokenAtom);
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function NotFound() {
  return (
    <main className="container mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold">404</h1>
      <p className="text-muted-foreground">The requested page could not be found.</p>
    </main>
  );
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/todos" replace /> },
      { path: "login", element: <Login /> },
      { path: "register", element: <Register /> },
      {
        path: "todos",
        element: (
          <RequireAuth>
            <Todos />
          </RequireAuth>
        ),
      },
      {
        path: "outbox-guide",
        element: (
          <RequireAuth>
            <OutboxGuide />
          </RequireAuth>
        ),
      },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
