import { redirect } from "next/navigation";
import { isAuthed } from "@/lib/auth";
import { MODELS } from "@/lib/anthropic";
import Chat from "@/components/Chat";

export default async function Home() {
  if (!(await isAuthed())) redirect("/login");
  return <Chat models={MODELS} />;
}
