// Fixture source for the coverage e2e specs.
//
// C#, and deliberately outside e2e/: the canvas classifies anything under a
// test folder as test code and excludes it from patch coverage and ranking, so
// a fixture that has to read as production code cannot live next to the specs.
//
// The Cobertura, LCOV and JaCoCo fixtures in e2e/fixtures/coverage refer to
// these line numbers directly. Adding or removing a line here means updating
// all three reports.
public static class Calc
{
    public static int Add(int a, int b)
    {
        return a + b;
    }

    public static int Sub(int a, int b)
    {
        return a - b;
    }

    public static int Divide(int a, int b)
    {
        if (b == 0)
        {
            throw new DivideByZeroException();
        }

        return a / b;
    }
}
