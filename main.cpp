#include <algorithm>
#include <cctype>
#include <cstdio>
#include <vector>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <ostream>
#include <string>
#include <functional>
#include <optional>
#include <regex>
#include <set>
#include <unordered_map>

                    // symbol -> filepath of all its refs
std::unordered_map<std::string, std::unordered_map<std::filesystem::path, uint32_t>> symbols;

struct Declaration
{
    std::filesystem::path file;
    uint32_t line;
};
                    // symbol -> where it was declared (last one wins)
std::unordered_map<std::string, Declaration> declarations;

struct DeclRange
{
    std::size_t namePos;    // offset of the symbol name
    std::size_t begin;      // offset of the keyword
    std::size_t end;        // offset of the closing brace
    std::string symbol;
};
                    // file -> extent of every declaration body in it
std::unordered_map<std::filesystem::path, std::vector<DeclRange>> declRanges;
                    // symbol -> symbols referenced inside its declaration body
std::unordered_map<std::string, std::set<std::string>> uses;

std::string identifier = "struct";
std::filesystem::path rootPath;
bool jsonOutput = false;
                    // only files whose relative path matches are scanned
std::optional<std::regex> fileFilter;

static bool isIdentChar(char c)
{
    return std::isalnum(static_cast<unsigned char>(c)) || c == '_';
}

static bool isIdentifier(const std::string& s)
{
    return !s.empty() && !std::isdigit(static_cast<unsigned char>(s[0])) &&
           std::all_of(s.begin(), s.end(), isIdentChar);
}

// Replaces comments and string/char literals with spaces, keeping newlines and offsets,
// so neither pass sees a declaration or a reference inside them.
static std::string stripCommentsAndLiterals(std::string s)
{
    auto blank = [&](std::size_t from, std::size_t to) {
        for(std::size_t k = from; k < to && k < s.size(); k++)
            if(s[k] != '\n')
                s[k] = ' ';
    };

    std::size_t i = 0;
    while(i < s.size())
    {
        const char c = s[i];
        if(c == '/' && i + 1 < s.size() && s[i + 1] == '/')
        {
            std::size_t e = s.find('\n', i);
            if(e == std::string::npos)
                e = s.size();
            blank(i, e);
            i = e;
        }
        else if(c == '/' && i + 1 < s.size() && s[i + 1] == '*')
        {
            std::size_t e = s.find("*/", i + 2);
            e = (e == std::string::npos) ? s.size() : e + 2;
            blank(i, e);
            i = e;
        }
        else if(c == '"' || c == '\'')
        {
            std::size_t e = i + 1;
            while(e < s.size() && s[e] != c && s[e] != '\n')
                e += (s[e] == '\\') ? 2 : 1;
            blank(i + 1, e);    // the quotes stay, so tokens around them remain separated
            i = std::min(e + 1, s.size());
        }
        else
            i++;
    }
    return s;
}

static bool readStripped(const std::filesystem::path& file, std::string& out)
{
    std::ifstream in(file, std::ios::binary);
    if(!in)
        return false;
    out = stripCommentsAndLiterals(std::string((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>()));
    return true;
}

// offset of the '}' matching the '{' at `open` (content already stripped)
static std::size_t findBodyEnd(const std::string& s, std::size_t open)
{
    int depth = 0;
    for(std::size_t i = open; i < s.size(); i++)
    {
        if(s[i] == '{')
            depth++;
        else if(s[i] == '}' && --depth == 0)
            return i;
    }
    return s.size();
}

void findDeclarations(const std::filesystem::path& file)
{
    std::string content;
    if(!readStripped(file, content))
        return;

    // running line counter, pos only ever moves forward
    uint32_t line = 1;
    std::size_t lineCursor = 0;

    for(std::size_t pos = content.find(identifier);
        pos != std::string::npos;
        pos = content.find(identifier, pos + identifier.size()))
    {
        line += static_cast<uint32_t>(std::count(content.begin() + lineCursor, content.begin() + pos, '\n'));
        lineCursor = pos;

        // the keyword itself must start a token ("mystruct Foo" is not a declaration)
        if(pos > 0 && isIdentChar(content[pos - 1]))
            continue;

        const std::size_t nameStart = pos + identifier.size();
        std::size_t nameEnd = nameStart;
        while(nameEnd < content.size() && isIdentChar(content[nameEnd]))
            nameEnd++;
        const std::string symbol = content.substr(nameStart, nameEnd - nameStart);
        if(!isIdentifier(symbol))
            continue;

        // A definition reaches '{' before any ';'. Between the name and the brace there is
        // nothing, "final", or a base clause; anything else ("struct Foo foo{}") is a variable.
        const std::size_t open = content.find_first_of("{;", nameEnd);
        if(open == std::string::npos || content[open] != '{')
            continue;
        const std::size_t first = content.find_first_not_of(" \t\r\n", nameEnd);
        if(first < open && content[first] != ':' && content.compare(first, 5, "final") != 0)
            continue;

        symbols[symbol].clear();
        declarations[symbol] = {file, line};
        declRanges[file].push_back({nameStart, pos, findBodyEnd(content, open), symbol});
    }
}

void findReferences(const std::filesystem::path& file)
{
    std::size_t maxLen = 0;
    for(const auto& [symbol, refs] : symbols)
        maxLen = std::max(maxLen, symbol.size());
    if(maxLen == 0)
        return;

    std::string content;
    if(!readStripped(file, content))
        return;

    const std::vector<DeclRange>* ranges = nullptr;
    if(auto found = declRanges.find(file); found != declRanges.end())
        ranges = &found->second;

    std::unordered_map<std::string, std::size_t> counts;

    // A reference is a whole identifier token equal to a symbol; "MyFoo" is not "Foo".
    for(std::size_t i = 0; i < content.size();)
    {
        if(!isIdentChar(content[i]))
        {
            i++;
            continue;
        }
        const std::size_t start = i;
        while(i < content.size() && isIdentChar(content[i]))
            i++;
        if(i - start > maxLen)
            continue;

        const std::string token = content.substr(start, i - start);
        if(!symbols.count(token))
            continue;

        // The declaration's own name is not a use. A use inside another declaration's
        // body is a dependency of that (innermost) declaration.
        const DeclRange* inside = nullptr;
        bool isDeclaration = false;
        if(ranges)
        {
            for(const DeclRange& r : *ranges)
            {
                if(r.namePos == start)
                    isDeclaration = true;
                else if(r.begin <= start && start <= r.end && (!inside || r.begin > inside->begin))
                    inside = &r;
            }
        }
        if(isDeclaration)
            continue;

        counts[token]++;
        symbols[token][file]++;
        if(inside && inside->symbol != token)
            uses[inside->symbol].insert(token);
    }

    if(jsonOutput)
        return;

    for(const auto& [symbol, count] : counts)
    {
        std::cout << symbol << " " << count << " " << file.filename() << std::endl;
    }
}

std::string jsonEscape(const std::string& s)
{
    std::string out;
    out.reserve(s.size() + 2);
    for(unsigned char c : s)
    {
        switch(c)
        {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if(c < 0x20)
                {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                }
                else
                    out += c;
        }
    }
    return out;
}

std::string relativePath(const std::filesystem::path& file)
{
    return file.lexically_relative(rootPath).generic_string();
}

void printJson()
{
    std::vector<std::string> names;
    names.reserve(symbols.size());
    for(const auto& [symbol, refs] : symbols)
        names.push_back(symbol);
    std::sort(names.begin(), names.end());

    std::cout << "{\n";
    std::cout << "  \"root\": \"" << jsonEscape(rootPath.generic_string()) << "\",\n";
    std::cout << "  \"identifier\": \"" << jsonEscape(identifier) << "\",\n";
    std::cout << "  \"symbols\": [\n";

    for(std::size_t n = 0; n < names.size(); n++)
    {
        const std::string& symbol = names[n];
        const auto& refs = symbols[symbol];

        std::cout << "    {\"name\": \"" << jsonEscape(symbol) << "\", ";

        auto decl = declarations.find(symbol);
        if(decl != declarations.end())
            std::cout << "\"decl\": {\"file\": \"" << jsonEscape(relativePath(decl->second.file))
                      << "\", \"line\": " << decl->second.line << "}, ";
        else
            std::cout << "\"decl\": null, ";

        std::cout << "\"uses\": [";
        if(auto used = uses.find(symbol); used != uses.end())
        {
            bool firstUse = true;
            for(const std::string& other : used->second)
            {
                std::cout << (firstUse ? "" : ", ") << "\"" << jsonEscape(other) << "\"";
                firstUse = false;
            }
        }
        std::cout << "], ";

        // sort refs by path so the output is stable between runs
        std::vector<std::pair<std::string, uint32_t>> sortedRefs;
        sortedRefs.reserve(refs.size());
        for(const auto& [file, count] : refs)
            sortedRefs.emplace_back(relativePath(file), count);
        std::sort(sortedRefs.begin(), sortedRefs.end());

        std::cout << "\"refs\": [";
        for(std::size_t r = 0; r < sortedRefs.size(); r++)
        {
            if(r > 0)
                std::cout << ", ";
            std::cout << "{\"file\": \"" << jsonEscape(sortedRefs[r].first)
                      << "\", \"count\": " << sortedRefs[r].second << "}";
        }
        std::cout << "]}" << (n + 1 < names.size() ? "," : "") << "\n";
    }

    std::cout << "  ]\n}\n";
}

void runOnFiles(const std::filesystem::path& dir, std::function<void(const std::filesystem::path&)> fileFn)
{
    std::error_code ec;

    std::filesystem::recursive_directory_iterator it(
        dir, std::filesystem::directory_options::skip_permission_denied, ec);

    for(; it != std::filesystem::recursive_directory_iterator(); it.increment(ec))
    {
        if(ec)
        {
            ec.clear();
            continue;
        }
        if(!it->is_regular_file(ec))
            continue;
        // the filter sees the path relative to the scan root, with '/' separators
        if(fileFilter && !std::regex_search(relativePath(it->path()), *fileFilter))
            continue;
        fileFn(it->path());
    }
}

int usage(const char* argv0)
{
    std::cerr << "usage: " << argv0 << " <directory> <identifier> <declaration_seperator> [--json] [--files <regex>]\n";
    return 1;
}

int main(int argc, char* argv[])
{
    if(argc < 4)
        return usage(argv[0]);

    std::string path(argv[1]);
    identifier = argv[2];
    identifier += argv[3];

    for(int i = 4; i < argc; i++)
    {
        std::string arg(argv[i]);
        if(arg == "--json")
            jsonOutput = true;
        else if(arg == "--files" && i + 1 < argc)
        {
            // ECMAScript grammar and case-insensitive, like the VS Code search box
            try
            {
                fileFilter.emplace(argv[++i], std::regex::ECMAScript | std::regex::icase);
            }
            catch(const std::regex_error& e)
            {
                std::cerr << "invalid --files regex \"" << argv[i] << "\": " << e.what() << "\n";
                return 1;
            }
        }
        else
            return usage(argv[0]);
    }

    std::filesystem::path targetPath = std::filesystem::current_path() / path;

    if(!std::filesystem::is_directory(targetPath))
    {
        std::cerr << targetPath << " is not a directory\n";
        return 1;
    }

    // canonical gives a clean absolute path, so the paths we iterate are relative-friendly
    std::error_code ec;
    rootPath = std::filesystem::canonical(targetPath, ec);
    if(ec)
        rootPath = targetPath.lexically_normal();

    runOnFiles(rootPath, findDeclarations);
    runOnFiles(rootPath, findReferences);

    if(jsonOutput)
        printJson();

    return 0;
}
