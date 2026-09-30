import { test, expect } from "@playwright/test";
test("register → challenge → run → submit → inspect verdict", async ({
  page,
}) => {
  await page.goto("/login");
  await page
    .getByRole("button", { name: "New here? Create an account" })
    .click();
  await page
    .getByLabel("Email address")
    .fill(`e2e-${crypto.randomUUID()}@example.com`);
  await page
    .getByLabel("Password", { exact: true })
    .fill("End-to-end-password-123");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(page).toHaveURL(/console\/playground/);
  await page.goto("/console/challenges/reverse-string");
  await expect(
    page.getByRole("heading", { name: "Reverse String" }),
  ).toBeVisible();
  await page.locator(".monaco-editor").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("print(input()[::-1])");
  await page.getByLabel("STANDARD INPUT").fill("arena");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByLabel("Standard output")).toContainText("anera", {
    timeout: 60000,
  });
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(page.locator(".editor-footer")).toContainText("accepted", {
    timeout: 60000,
  });
  await page.getByRole("link", { name: "View submission" }).click();
  await expect(
    page.getByRole("heading", { name: "Submission details" }),
  ).toBeVisible();
  await expect(
    page.getByText("Hidden inputs and outputs remain private"),
  ).toBeVisible();
});
