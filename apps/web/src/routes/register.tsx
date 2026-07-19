import { Link } from "react-router";

import { AuthForm } from "@/components/auth-form";
import { useAuth } from "@/hooks/use-auth";

export default function Register() {
  const { register } = useAuth();

  return (
    <AuthForm
      title="Create account"
      description="註冊一個新帳號（密碼至少 8 個字元）"
      submitLabel="Create account"
      onSubmit={register}
      footer={
        <span>
          已經有帳號？{" "}
          <Link to="/login" className="text-primary underline-offset-4 hover:underline">
            Sign in
          </Link>
        </span>
      }
    />
  );
}
