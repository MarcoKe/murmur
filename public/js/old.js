// Old browsers get a message instead of a silent page. A classic script on purpose: they would
// not run a module.
if (!(window.AudioContext || window.webkitAudioContext) || !('noModule' in HTMLScriptElement.prototype)) {
	var u = document.getElementById('unsupported');
	u.textContent = 'This browser is too old to make the sound. A current Chrome, Edge, Firefox or Safari will do.';
	u.hidden = false;
}
