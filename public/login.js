const form = document.getElementById("login-form");
const error = document.getElementById("login-error");

const session = await fetch("/api/session").then((r) => r.json()).catch(() => null);
if (session?.loggedIn) location.replace("/");
if (session && !session.passwordSet) {
  form.hidden = true;
  document.getElementById("no-password").hidden = false;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  error.hidden = true;
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "binance-bot" },
    body: JSON.stringify({ password: form.password.value }),
  });
  if (res.ok) {
    location.replace("/");
    return;
  }
  const body = await res.json().catch(() => ({}));
  error.textContent = body.error ?? `Login failed (${res.status})`;
  error.hidden = false;
  form.password.select();
});
