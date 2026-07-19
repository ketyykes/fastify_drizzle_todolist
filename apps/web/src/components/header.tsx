import { useAtomValue } from "jotai";
import { NavLink } from "react-router";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { isAuthenticatedAtom } from "@/lib/auth";

import { ModeToggle } from "./mode-toggle";

export default function Header() {
  const isAuthenticated = useAtomValue(isAuthenticatedAtom);
  const { logout } = useAuth();

  return (
    <div>
      <div className="flex flex-row items-center justify-between px-2 py-1">
        <nav className="flex gap-4 text-lg">
          <NavLink
            to="/todos"
            className={({ isActive }) => (isActive ? "font-bold" : "")}
          >
            Todo App
          </NavLink>
        </nav>
        <div className="flex items-center gap-2">
          <ModeToggle />
          {isAuthenticated ? (
            <Button variant="outline" size="sm" onClick={logout}>
              Logout
            </Button>
          ) : null}
        </div>
      </div>
      <hr />
    </div>
  );
}
