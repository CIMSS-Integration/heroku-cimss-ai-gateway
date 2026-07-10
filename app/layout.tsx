import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Salesforce Models API Chat",
  description: "Chat with Salesforce-hosted LLMs via the Models API",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/*
          `dynamic` renders Clerk at request time and `publishableKey` is read
          from a non-NEXT_PUBLIC env var so Next.js does NOT inline it at build.
          Heroku's CNB build can't see config vars, so the key is resolved at
          runtime on the dyno instead of being baked into the client bundle.
        */}
        <ClerkProvider dynamic publishableKey={process.env.CLERK_PUBLISHABLE_KEY}>
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
