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

std::string identifier = "struct";
std::filesystem::path rootPath;
bool jsonOutput = false;
                    // only files whose relative path matches are scanned
std::optional<std::regex> fileFilter;

void findDeclarations(const std::filesystem::path& file)
{
    std::ifstream in(file, std::ios::binary);
    if(!in)
        return;

    std::string content((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());

    // running line counter, pos only ever moves forward
    uint32_t line = 1;
    std::size_t lineCursor = 0;

    for(std::size_t pos = content.find(identifier);
        pos != std::string::npos;
        pos = content.find(identifier, pos + identifier.size()))
    {
        line += std::count(content.begin() + lineCursor, content.begin() + pos, '\n');
        lineCursor = pos;

        int i = 0;
        char c = content.at(pos + identifier.size() + i);
        std::string symbol = "";
        while(c != '\n' && c != ' ' && c != ';' && ((pos + identifier.size() + i + 1) < content.size()))
        {
            symbol += c;
            i++;
            c = content.at(pos + identifier.size() + i);
        }
        if(!symbol.empty() && 
            ((content.at(pos + identifier.size() + i) == ' ' &&
              content.at(pos + identifier.size() + i + 1) == '{') ||
              content.at(pos + identifier.size() + i) == '\n'))
        {
            symbols[symbol].clear();
            declarations[symbol] = {file, line};
        }
    }
}

static bool isIdentChar(char c)
{
    return std::isalnum(static_cast<unsigned char>(c)) || c == '_';
}

void findReferences(const std::filesystem::path& file)
{
    std::ifstream in(file, std::ios::binary);
    if(!in)
        return;

    std::size_t maxLen = 0;
    for(const auto& [symbol, refs] : symbols)
        maxLen = std::max(maxLen, symbol.size());
    if(maxLen == 0)
        return;

    std::string window;
    window.reserve(maxLen + 1);
    std::unordered_map<std::string, std::size_t> counts;

    for(std::istreambuf_iterator<char> it(in), end; it != end; ++it)
    {
        const char c = *it;

        if(c == ' ' || c == '&')
        {
            // A suffix only counts if it starts on a token boundary, so "MyFoo" does not match "Foo".
            // The window keeps one extra char before the longest candidate to check that boundary.
            const std::size_t maxCandidate = std::min(window.size(), maxLen);
            for(std::size_t len = 1; len <= maxCandidate; len++)
            {
                if(len < window.size() && isIdentChar(window[window.size() - len - 1]))
                    continue;

                std::string candidate = window.substr(window.size() - len);
                if(symbols.count(candidate))
                {
                    counts[candidate]++;
                    symbols[candidate][file]++;
                }
            }
        }

        window += c;
        if(window.size() > maxLen + 1)
            window.erase(0, 1);
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
