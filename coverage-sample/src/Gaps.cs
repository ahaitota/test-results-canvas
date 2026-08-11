// Fixture source for the "two ranked regions in one file" spec. Gaps.cs is
// uncovered at 13-15 and again at 22-24, far enough apart not to merge into one
// region, so it is ranked twice and each row has to expand on its own.
//
// Outside e2e/ for the same reason as Calc.cs: anything under a test folder is
// classified as test code and dropped from ranking. cobertura-two-gaps.xml
// refers to these line numbers directly.
public static class Gaps
{
    public static int Used(int a)
    {
        var guard = a;
        if (guard < 0)
        {
            return -1;
        }
        return guard;
    }

    public static int Unused(int b)
    {
        var x = b * 2;
        var y = x + 1;
        var z = y * 3;
        return z;
    }
}
