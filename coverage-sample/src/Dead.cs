// Fixture source that every coverage fixture reports as entirely uncovered, so
// the "Worth covering" ranking has a whole-file hotspot to surface.
public static class Dead
{
    public static string Shout(string input)
    {
        var trimmed = input.Trim();
        var upper = trimmed.ToUpperInvariant();
        return upper + "!";
    }
}
