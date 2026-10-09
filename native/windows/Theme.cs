using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace RemoteControl.Windows;

// Shared look for the desktop host: a light Fluent-like palette, Segoe/YaHei
// typography and flat buttons. Purely visual; no behaviour lives here.
internal static class Theme
{
    public static readonly Color Background = Color.FromArgb(243, 244, 247);
    public static readonly Color Surface = Color.White;
    public static readonly Color Border = Color.FromArgb(222, 225, 231);
    public static readonly Color Text = Color.FromArgb(28, 30, 36);
    public static readonly Color MutedText = Color.FromArgb(96, 102, 115);
    public static readonly Color Accent = Color.FromArgb(0, 103, 192);
    public static readonly Color AccentHover = Color.FromArgb(0, 88, 166);
    public static readonly Color Success = Color.FromArgb(16, 124, 65);
    public static readonly Color Warning = Color.FromArgb(157, 93, 0);
    public static readonly Color Danger = Color.FromArgb(196, 43, 28);
    public static readonly Color DangerSoft = Color.FromArgb(253, 236, 234);
    public static readonly Color Neutral = Color.FromArgb(138, 144, 156);

    private const string Family = "Microsoft YaHei UI";
    public static readonly Font Body = new(Family, 9.5f);
    public static readonly Font Small = new(Family, 8.75f);
    public static readonly Font Strong = new(Family, 10f, FontStyle.Bold);
    public static readonly Font Heading = new(Family, 11f, FontStyle.Bold);
    public static readonly Font Title = new(Family, 15f, FontStyle.Bold);
    public static readonly Font Mono = new("Consolas", 10f);

    public enum ButtonKind { Primary, Secondary, Danger }

    public static Button MakeButton(string text, ButtonKind kind = ButtonKind.Secondary)
    {
        var button = new Button
        {
            Text = text,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            MinimumSize = new Size(0, 34),
            Margin = new Padding(0, 4, 8, 4),
            Padding = new Padding(12, 2, 12, 2),
            FlatStyle = FlatStyle.Flat,
            Cursor = Cursors.Hand,
            Font = kind == ButtonKind.Primary ? Strong : Body,
            UseVisualStyleBackColor = false,
        };
        Color back, hover, fore, border;
        switch (kind)
        {
            case ButtonKind.Primary:
                back = Accent; hover = AccentHover; fore = Color.White; border = Accent; break;
            case ButtonKind.Danger:
                back = Surface; hover = DangerSoft; fore = Danger; border = Color.FromArgb(232, 180, 174); break;
            default:
                back = Surface; hover = Color.FromArgb(235, 238, 243); fore = Text; border = Border; break;
        }
        button.FlatAppearance.BorderSize = 1;
        button.FlatAppearance.MouseOverBackColor = hover;
        button.FlatAppearance.MouseDownBackColor = hover;
        void Apply()
        {
            // Flat buttons keep their colours when disabled; fade them explicitly.
            button.BackColor = button.Enabled ? back : Color.FromArgb(236, 237, 240);
            button.ForeColor = button.Enabled ? fore : Neutral;
            button.FlatAppearance.BorderColor = button.Enabled ? border : Border;
            button.Cursor = button.Enabled ? Cursors.Hand : Cursors.Default;
        }
        button.EnabledChanged += (_, _) => Apply();
        Apply();
        return button;
    }

    public static void StyleCheckBox(CheckBox box)
    {
        box.Font = Body;
        box.ForeColor = Text;
        box.Margin = new Padding(0, 4, 0, 2);
        box.Cursor = Cursors.Hand;
    }

    public static void StyleTextBox(TextBox box)
    {
        box.BorderStyle = BorderStyle.FixedSingle;
        box.BackColor = Surface;
        box.ForeColor = Text;
        box.Font = Body;
    }

    public static GraphicsPath Rounded(Rectangle bounds, int radius)
    {
        var path = new GraphicsPath();
        int d = Math.Max(1, Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height)));
        path.AddArc(bounds.Left, bounds.Top, d, d, 180, 90);
        path.AddArc(bounds.Right - d, bounds.Top, d, d, 270, 90);
        path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    // Mix a colour towards white: amount 0 keeps it, 1 is pure white.
    public static Color Tint(Color color, double amount) => Color.FromArgb(
        color.R + (int)((255 - color.R) * amount),
        color.G + (int)((255 - color.G) * amount),
        color.B + (int)((255 - color.B) * amount));
}

// A rounded "● 运行中" pill used in the header.
internal sealed class StatusPill : Control
{
    private Color dot = Theme.Neutral;

    public StatusPill()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        Font = Theme.Body;
        BackColor = Theme.Surface;
        TabStop = false;
    }

    public void Set(string text, Color color)
    {
        if (Text == text && dot == color) return;
        Text = text;
        dot = color;
        Size textSize = TextRenderer.MeasureText(text, Font);
        Size = new Size(textSize.Width + LogicalToDeviceUnits(34), textSize.Height + LogicalToDeviceUnits(12));
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var bounds = new Rectangle(0, 0, Width - 1, Height - 1);
        using (var path = Theme.Rounded(bounds, Height / 2))
        using (var fill = new SolidBrush(Theme.Tint(dot, 0.88)))
        using (var pen = new Pen(Theme.Tint(dot, 0.6)))
        {
            g.FillPath(fill, path);
            g.DrawPath(pen, path);
        }
        int size = LogicalToDeviceUnits(8), left = LogicalToDeviceUnits(12);
        using (var brush = new SolidBrush(dot)) g.FillEllipse(brush, left, (Height - size) / 2f, size, size);
        var textBounds = new Rectangle(left + size + LogicalToDeviceUnits(6), 0, Width, Height);
        TextRenderer.DrawText(g, Text, Font, textBounds, Theme.Text, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPadding);
    }
}

// A white rounded card with a numbered heading, replacing the old GroupBox.
// The parent sets its width via Fit(); the card then wraps labels, folds
// button rows and sizes its own height to the content.
internal sealed class Card : Panel
{
    private readonly string number, title, subtitle;
    public FlowLayoutPanel Body { get; }

    public Card(int number, string title, string subtitle)
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        this.number = number.ToString();
        this.title = title;
        this.subtitle = subtitle;
        BackColor = Theme.Background;
        Body = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.TopDown, WrapContents = false,
            AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
            BackColor = Theme.Surface, ForeColor = Theme.Text, Margin = Padding.Empty,
        };
        Controls.Add(Body);
        Body.SizeChanged += (_, _) => Height = Body.Bottom + LogicalToDeviceUnits(16);
    }

    public void Fit(int width)
    {
        Width = width;
        int inner = width - LogicalToDeviceUnits(56);
        Body.Location = new Point(LogicalToDeviceUnits(56), LogicalToDeviceUnits(50));
        Body.SuspendLayout();
        foreach (Control child in Body.Controls)
        {
            int available = Math.Max(LogicalToDeviceUnits(80), inner - LogicalToDeviceUnits(20) - child.Margin.Horizontal);
            switch (child)
            {
                case Label or FlowLayoutPanel: child.MaximumSize = new Size(available, 0); break;
                case TextBox { Multiline: true }: child.Width = available; break;
                case Panel: child.Width = available; break;
            }
        }
        Body.ResumeLayout(true);
        Height = Body.Bottom + LogicalToDeviceUnits(16);
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(Theme.Background);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using (var path = Theme.Rounded(new Rectangle(0, 0, Width - 1, Height - 1), LogicalToDeviceUnits(10)))
        using (var fill = new SolidBrush(Theme.Surface))
        using (var pen = new Pen(Theme.Border))
        {
            g.FillPath(fill, path);
            g.DrawPath(pen, path);
        }
        int left = LogicalToDeviceUnits(18), top = LogicalToDeviceUnits(16), badge = LogicalToDeviceUnits(26);
        using (var brush = new SolidBrush(Theme.Accent)) g.FillEllipse(brush, left, top, badge, badge);
        TextRenderer.DrawText(g, number, Theme.Strong, new Rectangle(left, top, badge, badge), Color.White,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        int x = LogicalToDeviceUnits(56);
        int titleWidth = TextRenderer.MeasureText(g, title, Theme.Heading, Size.Empty, TextFormatFlags.NoPadding).Width;
        TextRenderer.DrawText(g, title, Theme.Heading, new Rectangle(x, top, titleWidth + 4, badge), Theme.Text,
            TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPadding);
        int subX = x + titleWidth + LogicalToDeviceUnits(10);
        TextRenderer.DrawText(g, subtitle, Theme.Small, new Rectangle(subX, top, Math.Max(0, Width - subX - LogicalToDeviceUnits(16)), badge), Theme.MutedText,
            TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);
    }
}

// Scrollable page that stacks full-width children with a fixed gap.
internal sealed class StackPage : Panel
{
    private bool arranging;

    public StackPage()
    {
        Dock = DockStyle.Fill;
        AutoScroll = true;
        BackColor = Theme.Background;
        Padding = new Padding(LogicalToDeviceUnits(20), LogicalToDeviceUnits(16), LogicalToDeviceUnits(20), LogicalToDeviceUnits(16));
        Resize += (_, _) => Arrange();
    }

    public void Add(Control child)
    {
        Controls.Add(child);
        child.SizeChanged += (_, _) => Arrange();
        child.VisibleChanged += (_, _) => Arrange();
        Arrange();
    }

    public void Arrange()
    {
        if (arranging) return;
        arranging = true;
        try
        {
            var scroll = AutoScrollPosition;
            int width = Math.Max(LogicalToDeviceUnits(300), ClientSize.Width - Padding.Horizontal);
            int y = Padding.Top + scroll.Y, gap = LogicalToDeviceUnits(12);
            // Without docking, Controls keeps insertion order: stack top to bottom.
            foreach (Control child in Controls)
            {
                if (child is Card card) card.Fit(width);
                else child.Width = width;
                if (child.Height == 0) continue; // collapsed (e.g. empty error banner)
                child.Location = new Point(Padding.Left + scroll.X, y);
                y += child.Height + gap;
            }
            AutoScrollMinSize = new Size(0, y - scroll.Y - gap + Padding.Bottom);
        }
        finally { arranging = false; }
    }
}

// Rounded alert strip for errorState. Collapses to zero height when empty so
// the page stack skips it; grows to fit wrapped text otherwise.
internal sealed class NoticeBanner : Label
{
    public NoticeBanner()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        AutoSize = false;
        Font = Theme.Body;
        ForeColor = Theme.Danger;
        BackColor = Theme.Background;
        Height = 0;
    }

    private int TextLeft => LogicalToDeviceUnits(44);
    private int TextRight => LogicalToDeviceUnits(14);
    private int VerticalPadding => LogicalToDeviceUnits(11);

    private void Fit()
    {
        int height = 0;
        if (!string.IsNullOrEmpty(Text) && Width > 0)
        {
            var size = TextRenderer.MeasureText(Text, Font, new Size(Math.Max(1, Width - TextLeft - TextRight), 0), TextFormatFlags.WordBreak | TextFormatFlags.NoPadding);
            height = Math.Max(size.Height, LogicalToDeviceUnits(20)) + VerticalPadding * 2;
        }
        if (Height != height) Height = height;
    }

    protected override void OnTextChanged(EventArgs e) { base.OnTextChanged(e); Fit(); Invalidate(); }
    protected override void OnSizeChanged(EventArgs e) { base.OnSizeChanged(e); if (!fitting) { fitting = true; try { Fit(); } finally { fitting = false; } } }
    private bool fitting;

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(Theme.Background);
        if (string.IsNullOrEmpty(Text) || Height <= 0) return;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using (var path = Theme.Rounded(new Rectangle(0, 0, Width - 1, Height - 1), LogicalToDeviceUnits(8)))
        using (var fill = new SolidBrush(Theme.DangerSoft))
        using (var pen = new Pen(Theme.Tint(ForeColor, 0.65)))
        {
            g.FillPath(fill, path);
            g.DrawPath(pen, path);
        }
        int icon = LogicalToDeviceUnits(20), x = LogicalToDeviceUnits(14), y = VerticalPadding;
        using (var brush = new SolidBrush(ForeColor)) g.FillEllipse(brush, x, y, icon, icon);
        TextRenderer.DrawText(g, "!", Theme.Strong, new Rectangle(x, y, icon, icon), Color.White,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        var bounds = new Rectangle(TextLeft, y, Width - TextLeft - TextRight, Height - y * 2);
        TextRenderer.DrawText(g, Text, Font, bounds, Theme.Text, TextFormatFlags.WordBreak | TextFormatFlags.NoPadding | TextFormatFlags.VerticalCenter);
    }
}
