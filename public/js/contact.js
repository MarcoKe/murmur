// Name, address and e-mail for the legal pages. They are put together here, not written in the HTML,
// so that scrapers that don't run scripts find nothing; people, copy & paste and screen readers get
// normal text. Search engines are kept out by noindex anyway. Each value is the text reversed,
// as UTF-8 in base64: python3 -c "import base64; print(base64.b64encode('text'[::-1].encode()).decode())"
const CONTACT = {
	name: 'Z25pbHJlbW1lSyBvY3JhTQ==',
	street: 'MjYxIC5ydHNuZWxow7xtZG5pVw==',
	city: 'bmzDtksgMzYwMTU=',
	email: 'bW9jLmZkcGxvbXNAbGlhbQ==',
};

const decode = (s) => [...new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))].reverse().join('');

for (const el of document.querySelectorAll('[data-contact]')) {
	const value = decode(CONTACT[el.dataset.contact]);
	el.textContent = value;
	if (el.dataset.contact === 'email') el.href = `mailto:${value}`;
}
