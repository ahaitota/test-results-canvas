// Fixture whose *contents* are hostile, for the coverage source view. A source
// file is attacker-controlled the moment you agree to display it, so the gutter
// view has to escape the code it shows rather than let a browser parse it.
// <img src=x onerror="window.__SRC_COMMENT_XSS=1">
public static class Hostile
{
    public const string Payload = "</span><img src=x onerror=\"window.__SRC_XSS=1\">";

    public static string Render() => "</div><script>window.__SRC_SCRIPT_XSS=1</script>";
}
