import { Link } from "react-router";

import { AuthForm } from "@/components/auth-form";
import { useAuth } from "@/hooks/use-auth";

export default function Login() {
  const { login } = useAuth();

  return (
    <AuthForm
      title="Sign in"
      description="登入以管理你的待辦事項"
      submitLabel="Sign in"
      onSubmit={login}
      footer={
        <span>
          還沒有帳號？{" "}
          <Link to="/register" className="text-primary underline-offset-4 hover:underline">
            Register
          </Link>
        </span>
      }
    />
  );
}
